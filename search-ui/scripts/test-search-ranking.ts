import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import API from "@searchkit/api";
import {
  buildAgentSearchBody,
  parseAgentSearchQuery,
} from "../server/agent-api";
import { buildLuceneQueryBody } from "../server/lucene-query";
import {
  phraseAnalyzer,
  phraseSearchFields,
  withPhraseFallback,
  type PhraseMode,
} from "../server/phrase-mode";
import {
  FUZZY_CLAUSE_BUDGET,
  PLAIN_CLAUSE_BUDGET,
  fuzzyExpansionLimit,
  instantSearchStrictQuery,
  plainQueryLimit,
  searchkitConfig,
  textSearchAttributes,
  withOmittedTerms,
} from "../server/searchkit-config";

const here = dirname(fileURLToPath(import.meta.url));
const mappingPath = join(here, "../../deploy/opensearch/index_mappings.json");
const opensearchUrl = (process.env.OPENSEARCH_URL ?? "http://127.0.0.1:9200").replace(
  /\/$/,
  "",
);
const index = "feedback-search-ranking-test";

function fuzzinessValues(query: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "fuzziness") found.push(String(child));
      else walk(child);
    }
  };
  walk(query);
  return found;
}

function constantBoosts(query: unknown): number[] {
  const found: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const constant = record.constant_score;
    if (constant && typeof constant === "object") {
      const boost = (constant as { boost?: unknown }).boost;
      if (typeof boost === "number") found.push(boost);
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(query);
  return found;
}

function queryMentions(value: unknown, text: string): boolean {
  if (Array.isArray(value)) return value.some((item) => queryMentions(item, text));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const multi = record.multi_match;
  if (multi && typeof multi === "object" && (multi as { query?: unknown }).query === text) {
    return true;
  }
  return Object.values(record).some((child) => queryMentions(child, text));
}

/** Constant boosts whose filter is a match for this query string. */
function constantBoostsForMatch(query: unknown, text: string): number[] {
  const found: number[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const constant = record.constant_score;
    if (constant && typeof constant === "object") {
      const body = constant as { boost?: unknown; filter?: unknown };
      if (typeof body.boost === "number" && queryMentions(body.filter, text)) {
        found.push(body.boost);
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(query);
  return found;
}

function proximityGroups(query: unknown): Array<{
  field: string;
  ordered: unknown;
  maxGaps: unknown;
  queries: string[];
}> {
  const found: Array<{ field: string; ordered: unknown; maxGaps: unknown; queries: string[] }> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const intervals = record.intervals;
    if (intervals && typeof intervals === "object" && !Array.isArray(intervals)) {
      for (const [field, spec] of Object.entries(intervals as Record<string, unknown>)) {
        if (!spec || typeof spec !== "object") continue;
        const allOf = (spec as { all_of?: unknown }).all_of;
        if (!allOf || typeof allOf !== "object") continue;
        const body = allOf as {
          ordered?: unknown;
          max_gaps?: unknown;
          intervals?: Array<{ match?: { query?: unknown } }>;
        };
        found.push({
          field,
          ordered: body.ordered,
          maxGaps: body.max_gaps,
          queries: (body.intervals ?? []).map((item) => String(item.match?.query ?? "")),
        });
      }
    }
    for (const child of Object.values(record)) walk(child);
  };
  walk(query);
  return found;
}

function partKey(group: { queries: string[] }): string {
  return group.queries.map((part) => part.toLowerCase()).join(" ");
}

function fuzzyMatches(query: unknown): Array<{ text: string; expansions: number }> {
  const found: Array<{ text: string; expansions: number }> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const multi = (value as { multi_match?: unknown }).multi_match;
    if (multi && typeof multi === "object") {
      const body = multi as { query?: unknown; fuzziness?: unknown; max_expansions?: unknown };
      if (
        body.fuzziness === "AUTO:5,100" &&
        typeof body.query === "string" &&
        typeof body.max_expansions === "number"
      ) {
        found.push({ text: body.query, expansions: body.max_expansions });
      }
    }
    for (const child of Object.values(value as Record<string, unknown>)) walk(child);
  };
  walk(query);
  return found;
}

const groupIdsQuery = instantSearchStrictQuery("groupIds", textSearchAttributes);
const groupIdsProximity = proximityGroups(groupIdsQuery);
assert.ok(groupIdsProximity.length > 0, "groupIds should require its split parts to be adjacent");
for (const group of groupIdsProximity) {
  assert.equal(group.ordered, false);
  assert.equal(group.maxGaps, 0);
  assert.deepEqual(
    group.queries.map((part) => part.toLowerCase()),
    ["group", "ids"],
  );
}
assert.equal(
  proximityGroups(instantSearchStrictQuery("group ids", textSearchAttributes)).length,
  0,
);
assert.deepEqual(
  instantSearchStrictQuery("widget alpha", textSearchAttributes),
  instantSearchStrictQuery("alpha widget", textSearchAttributes),
);
assert.deepEqual(
  instantSearchStrictQuery("aBc AbC", textSearchAttributes),
  instantSearchStrictQuery("AbC aBc", textSearchAttributes),
);
const fiveWords = ["avatar", "widget", "zebra", "stable", "polygon"];
const fiveBuilt = instantSearchStrictQuery(fiveWords.join(" "), textSearchAttributes);
const fiveFuzzy = fuzzyMatches(fiveBuilt);
const fiveExpansions = fuzzyExpansionLimit(fiveWords.length);
assert.ok(fiveExpansions >= 1, "a 5-word query keeps a fuzzy band");
assert.equal(new Set(fiveFuzzy.map((item) => item.text)).size, fiveWords.length);
for (const word of fiveWords) {
  assert.ok(fiveFuzzy.some((item) => item.text === word), `${word} keeps typo tolerance`);
}
assert.ok(fiveFuzzy.every((item) => item.expansions === fiveExpansions));
assert.ok(plainQueryLimit(fiveWords.join(" ")).clauses <= FUZZY_CLAUSE_BUDGET);
assert.equal(plainQueryLimit(fiveWords.join(" ")).omittedTerms.length, 0);
const extraFields = [...textSearchAttributes, "notes"];
assert.ok(
  fuzzyExpansionLimit(fiveWords.length, extraFields) < fiveExpansions,
  "another searched field shrinks max_expansions",
);
const extraFuzzy = fuzzyMatches(instantSearchStrictQuery(fiveWords.join(" "), extraFields));
assert.ok(extraFuzzy.every((item) => item.expansions === fuzzyExpansionLimit(fiveWords.length, extraFields)));
const tenWords = [...fiveWords, "desktop", "microphone", "performance", "tracking", "companion"];
const tenBuilt = instantSearchStrictQuery(tenWords.join(" "), textSearchAttributes);
const tenFuzzy = fuzzyMatches(tenBuilt);
const tenExpansions = fuzzyExpansionLimit(tenWords.length);
assert.ok(tenExpansions >= 1, "a 10-word query keeps a fuzzy band");
for (const word of tenWords) {
  assert.ok(tenFuzzy.some((item) => item.text === word), `${word} keeps typo tolerance`);
}
assert.ok(tenFuzzy.every((item) => item.expansions === tenExpansions));
assert.ok(plainQueryLimit(tenWords.join(" ")).clauses <= FUZZY_CLAUSE_BUDGET);
assert.equal(plainQueryLimit(tenWords.join(" ")).omittedTerms.length, 0);
const fortyTerms = Array.from({ length: 40 }, (_, index) => `zz${index}`);
assert.deepEqual(plainQueryLimit(fortyTerms.join(" ")).omittedTerms, []);
const fortyQuery = JSON.stringify(instantSearchStrictQuery(fortyTerms.join(" "), textSearchAttributes));
for (const term of fortyTerms) {
  assert.equal(fortyQuery.includes(`"${term}"`), true, term);
}
const hundredTerms = Array.from({ length: 100 }, (_, index) => `zz${index}`);
const hundredLimit = plainQueryLimit(hundredTerms.join(" "));
assert.equal(hundredLimit.omittedTerms.length, 20);
assert.equal(hundredLimit.omittedTerms[0], "zz9");
for (const term of ["zz0", "zz9", "zz90", "zz99"]) {
  assert.equal(hundredLimit.omittedTerms.includes(term), true, term);
}
for (const term of ["zz10", "zz50", "zz89"]) {
  assert.equal(hundredLimit.omittedTerms.includes(term), false, term);
}
assert.ok(hundredLimit.clauses <= PLAIN_CLAUSE_BUDGET);
const stamped = withOmittedTerms({ results: [{ hits: [] }] }, [hundredTerms.join(" ")], false) as {
  results: Array<{ omittedTerms: string[] }>;
};
assert.deepEqual(stamped.results[0]?.omittedTerms, hundredLimit.omittedTerms);
const luceneStamped = withOmittedTerms({ results: [{ hits: [] }] }, ["score:[10 TO *]"], true) as {
  results: Array<{ omittedTerms: string[] }>;
};
assert.deepEqual(luceneStamped.results[0]?.omittedTerms, []);
assert.equal(
  proximityGroups(instantSearchStrictQuery("ids group", textSearchAttributes)).length,
  0,
);
const sdkProximity = proximityGroups(instantSearchStrictQuery("SDK3", textSearchAttributes));
assert.ok(sdkProximity.length > 0, "SDK3 should require its split parts to be adjacent");
for (const group of sdkProximity) {
  assert.equal(group.ordered, false);
  assert.equal(group.maxGaps, 0);
  assert.deepEqual(
    group.queries.map((part) => part.toLowerCase()),
    ["sdk", "3"],
  );
}
const fuzziness = fuzzinessValues(groupIdsQuery);
assert.deepEqual(
  fuzziness.filter((value) => value !== "0"),
  ["AUTO:5,100"],
  `fuzzy clause should be edit-distance 1 for normal identifier lengths, got ${fuzziness.join(",")}`,
);
assert.equal(fuzziness.includes("AUTO"), false);
assert.equal(
  groupIdsProximity.some((group) => group.field.endsWith(".phrase")),
  false,
  "groupIds has no internal stop word",
);
const endOfLineQuery = instantSearchStrictQuery("endOfLine", textSearchAttributes);
const endOfLineProximity = proximityGroups(endOfLineQuery);
assert.ok(endOfLineProximity.some((group) => partKey(group) === "end line"));
assert.ok(
  endOfLineProximity.some(
    (group) => group.field.endsWith(".phrase") && partKey(group) === "end of line",
  ),
  "endOfLine keeps the stop word on .phrase",
);
for (const group of endOfLineProximity) {
  assert.equal(group.ordered, false);
  assert.equal(group.maxGaps, 0);
}
const camelSynonym = instantSearchStrictQuery("fullBodyTracking", textSearchAttributes);
assert.equal(JSON.stringify(camelSynonym).includes('"fbt"'), true);
assert.ok(
  proximityGroups(camelSynonym).some((group) => partKey(group) === "full body tracking"),
);
const camelFbtBoosts = constantBoostsForMatch(camelSynonym, "fbt");
assert.ok(camelFbtBoosts.length > 0, "fullBodyTracking should score the fbt synonym");
assert.deepEqual(
  camelFbtBoosts,
  camelFbtBoosts.map(() => 50),
  `identifier synonym fbt should use the adjacent band, got ${camelFbtBoosts.join(",")}`,
);
const reverseCamelSynonym = instantSearchStrictQuery("trackingBodyFull", textSearchAttributes);
const reverseFbtBoosts = constantBoostsForMatch(reverseCamelSynonym, "fbt");
assert.ok(reverseFbtBoosts.length > 0, "trackingBodyFull should score the fbt synonym");
assert.deepEqual(
  reverseFbtBoosts,
  reverseFbtBoosts.map(() => 50),
  `identifier synonym fbt should use the adjacent band, got ${reverseFbtBoosts.join(",")}`,
);
assert.ok(
  constantBoostsForMatch(instantSearchStrictQuery("fbt", textSearchAttributes), "fbt").includes(
    1000,
  ),
  "a typed fbt term keeps the exact band",
);
assert.ok(
  constantBoostsForMatch(
    instantSearchStrictQuery("full body tracking", textSearchAttributes),
    "fbt",
  ).includes(1000),
  "a typed full body tracking synonym keeps the exact band on fbt",
);
const boosts = constantBoosts(groupIdsQuery);
const bands = [...new Set(boosts)].sort((left, right) => left - right);
assert.ok(
  bands.length >= 3,
  `expected exact, adjacent, and fuzzy score bands, got ${bands.join(",")}`,
);
assert.ok(bands[0]! <= 10, `fuzzy band should stay at or below 10, got ${bands.join(",")}`);
assert.ok(bands[bands.length - 1]! >= 100);
assert.ok(bands[bands.length - 1]! > bands[0]! * 10);
assert.ok(
  bands.some((band) => band > bands[0]! && band < bands[bands.length - 1]!),
  `adjacent band should sit between fuzzy and exact, got ${bands.join(",")}`,
);

const quoted = instantSearchStrictQuery('"full body"', textSearchAttributes);
const quotedBool = quoted as { bool?: { must?: unknown } };
assert.ok(Array.isArray(quotedBool.bool?.must), "quoted text is a required phrase");

type Fixture = {
  post_id: string;
  title: string;
  details: string;
  status?: string;
  score?: number;
  commentCount?: number;
  created: string;
  board?: { name: string; urlName: string };
  author?: { name: string };
  comments?: Array<{ value: string; pinned?: boolean }>;
  voteSettings?: { highEngagement?: boolean };
};

const docs: Fixture[] = [
  {
    post_id: "exact-groupids",
    title: "Add groupIds to the API",
    details: "The groupIds field is required on the request",
    status: "open",
    score: 12,
    commentCount: 2,
    created: "2019-01-01T00:00:00.000Z",
    board: { name: "Bug Reports", urlName: "bug-reports" },
    author: { name: "Ada" },
  },
  {
    post_id: "camel-role",
    title: "Expose roleIds",
    details: "Need roleIds and {groupId} in the payload",
    status: "open",
    created: "2019-02-01T00:00:00.000Z",
    board: { name: "Bug Reports", urlName: "bug-reports" },
  },
  {
    post_id: "group-words",
    title: "Group lobbies",
    details: "Filter by group rank and group name in Group lobbies",
    status: "open",
    score: 3,
    commentCount: 1,
    created: "2024-12-01T00:00:00.000Z",
    board: { name: "Bug Reports", urlName: "bug-reports" },
  },
  {
    post_id: "group-id-words",
    title: "Show the group id",
    details: "Display group id on the profile",
    status: "open",
    score: 8,
    commentCount: 4,
    created: "2024-11-01T00:00:00.000Z",
    board: { name: "Bug Reports", urlName: "bug-reports" },
  },
  {
    post_id: "group-sentence",
    title: "The group is ready",
    details: "An id is shown later",
    status: "open",
    created: "2021-02-01T00:00:00.000Z",
  },
  {
    post_id: "group-has-id",
    title: "The group has an id",
    details: "A group has an id field in the form",
    status: "open",
    created: "2021-04-01T00:00:00.000Z",
  },
  {
    post_id: "ids-group",
    title: "Label placement",
    details:
      "The panel says ids group in that order and then repeats a lot of unrelated words about layout padding and windows so this is not a short field",
    status: "open",
    created: "2016-06-01T00:00:00.000Z",
  },
  {
    post_id: "closed-groupids",
    title: "Retired request",
    details:
      "The old payload included groupIds but this request is finished and kept only for history",
    status: "closed",
    created: "2017-01-01T00:00:00.000Z",
  },
  {
    post_id: "grop-ids",
    title: "gropIds typo",
    details: "The notes say gropIds instead of the real field",
    status: "open",
    created: "2021-01-01T00:00:00.000Z",
  },
  {
    post_id: "url-doc",
    title: "Docs link",
    details: "See http://example.com/docs/groupIds for the field",
    status: "open",
    created: "2020-05-01T00:00:00.000Z",
    board: { name: "Bug Reports", urlName: "bug-reports" },
  },
  {
    post_id: "csharp",
    title: "C# scripting",
    details: "Write the mod in C#",
    status: "open",
    created: "2020-01-02T00:00:00.000Z",
  },
  {
    post_id: "cplusplus",
    title: "C++ bindings",
    details: "Expose the native API to C++",
    status: "open",
    created: "2020-01-03T00:00:00.000Z",
  },
  {
    post_id: "letter-c",
    title: "Logged in with C",
    details: "Option C was selected",
    status: "open",
    created: "2024-06-01T00:00:00.000Z",
  },
  {
    post_id: "vrcplus",
    title: "VRC+ perks",
    details: "VRC+ should include this feature",
    status: "open",
    created: "2020-03-01T00:00:00.000Z",
  },
  {
    post_id: "full-body",
    title: "Add full body tracking",
    details: "full body tracking for avatars",
    status: "open",
    created: "2020-04-01T00:00:00.000Z",
  },
  {
    post_id: "reversed-body",
    title: "Tracking body is full",
    details: "the body comes before full here",
    status: "open",
    created: "2024-04-01T00:00:00.000Z",
  },
  {
    post_id: "fbt-only",
    title: "FBT calibration",
    details: "Calibrate fbt before play",
    status: "open",
    created: "2018-04-01T00:00:00.000Z",
  },
  {
    post_id: "full-body-camel",
    title: "fullBodyTracking option",
    details: "Expose fullBodyTracking in the menu",
    status: "open",
    created: "2019-04-01T00:00:00.000Z",
  },
  {
    post_id: "end-of-line-camel",
    title: "endOfLine handling",
    details: "Honor endOfLine in the file",
    status: "open",
    created: "2019-02-01T00:00:00.000Z",
  },
  {
    post_id: "end-of-line",
    title: "Wrap end of line",
    details: "Break at the end of line in the editor",
    status: "open",
    created: "2020-02-01T00:00:00.000Z",
  },
  {
    post_id: "end-line",
    title: "Marker",
    details: "The label says end line with nothing between",
    status: "open",
    created: "2016-02-01T00:00:00.000Z",
  },
  {
    post_id: "end-foo-line",
    title: "Spacing",
    details: "The label says end foo line with a word between",
    status: "open",
    created: "2020-02-02T00:00:00.000Z",
  },
  {
    post_id: "end-sentence",
    title: "The end is ready",
    details: "A line is shown later",
    status: "open",
    created: "2021-02-02T00:00:00.000Z",
  },
  {
    post_id: "performance",
    title: "Avatar performance",
    details: "Improve avatar performance in crowds",
    status: "open",
    created: "2019-06-01T00:00:00.000Z",
  },
  {
    post_id: "performence",
    title: "Avatar performence",
    details: "The performence is bad",
    status: "open",
    created: "2022-01-01T00:00:00.000Z",
  },
  {
    post_id: "avatar-only",
    title: "New avatar",
    details: "Upload an avatar",
    status: "open",
    created: "2023-01-01T00:00:00.000Z",
  },
  {
    post_id: "avatr-typo",
    title: "Avatr typo",
    details: "avatr is misspelled here",
    status: "open",
    created: "2018-01-01T00:00:00.000Z",
  },
  {
    post_id: "udonsharp",
    title: "UdonSharp compiler",
    details: "UdonSharp error on build",
    status: "open",
    created: "2019-07-01T00:00:00.000Z",
  },
  {
    post_id: "udon-word",
    title: "Udon graph",
    details: "Use udon nodes",
    status: "open",
    created: "2024-08-01T00:00:00.000Z",
  },
  {
    post_id: "player",
    title: "playerId mismatch",
    details: "playerId and playerID should match",
    status: "open",
    created: "2020-08-01T00:00:00.000Z",
  },
  {
    post_id: "sdk3",
    title: "SDK3 upload fails",
    details: "SDK3 rejects the package",
    status: "open",
    created: "2020-09-01T00:00:00.000Z",
  },
  {
    post_id: "sdk-word",
    title: "The sdk manual",
    details: "Read the sdk documentation",
    status: "open",
    created: "2020-09-02T00:00:00.000Z",
  },
  {
    post_id: "sdk-prose",
    title: "Upload with sdk 3",
    details: "The sdk 3 package fails",
    status: "open",
    created: "2020-09-03T00:00:00.000Z",
  },
  {
    post_id: "menu-bare",
    title: "Menu overlap",
    details: "Menu overlaps nameplate",
    status: "open",
    created: "2025-01-01T00:00:00.000Z",
  },
  {
    post_id: "menu-bug",
    title: "Fix the menu",
    details: "the menu covers the nameplate",
    status: "open",
    created: "2025-01-02T00:00:00.000Z",
  },
  {
    post_id: "menu-only",
    title: "Open the menu",
    details: "the menu is missing a label",
    status: "open",
    created: "2025-01-03T00:00:00.000Z",
  },
  {
    post_id: "menu-load",
    title: "Menu does not load",
    details: "The button does nothing",
    status: "open",
    created: "2025-01-04T00:00:00.000Z",
  },
  {
    post_id: "working-only",
    title: "It is working",
    details: "The feature is working again",
    status: "open",
    created: "2024-07-01T00:00:00.000Z",
  },
  {
    post_id: "optimization",
    title: "Avatar optimization",
    details: "Run an optimization pass",
    status: "open",
    created: "2019-09-01T00:00:00.000Z",
  },
  {
    post_id: "optmization",
    title: "Avatar optmization",
    details: "optmization typo in the title",
    status: "open",
    created: "2021-09-01T00:00:00.000Z",
  },
  {
    post_id: "merch",
    title: "Store merch",
    details: "Buy a shirt",
    status: "closed",
    created: "2024-01-01T00:00:00.000Z",
    board: { name: "Feature Requests", urlName: "feature-requests" },
  },
  {
    post_id: "status-open",
    title: "Open avatar idea",
    details: "An avatar idea still open",
    status: "open",
    created: "2020-02-01T00:00:00.000Z",
    voteSettings: { highEngagement: true },
    comments: [{ value: "groupIds mentioned in a comment", pinned: true }],
  },
  {
    post_id: "status-closed",
    title: "Closed avatar idea",
    details: "An avatar idea that was closed",
    status: "closed",
    created: "2020-02-02T00:00:00.000Z",
    comments: [{ value: "not pinned", pinned: false }],
  },
];

function withCombined(doc: Fixture): Fixture & { combined_text: string } {
  const comments = (doc.comments ?? []).map((comment) => comment.value).join("\n");
  const combined = [doc.title, doc.details, doc.author?.name ?? "", comments]
    .filter((part) => part.length > 0)
    .join("\n");
  return { ...doc, combined_text: combined };
}

async function os(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${opensearchUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 800)}`);
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

function hitIds(payload: unknown): string[] {
  return hitRanks(payload).map((rank) => rank.slice(0, rank.lastIndexOf("@")));
}

function hitRanks(payload: unknown): string[] {
  const hits = (
    payload as {
      hits?: { hits?: Array<{ _score?: number; _source?: { post_id?: string } }> };
    }
  ).hits?.hits;
  return (hits ?? []).map((hit) => `${hit._source?.post_id ?? ""}@${hit._score ?? 0}`);
}

async function search(query: unknown): Promise<string[]> {
  return hitIds(await searchPayload(query));
}

async function searchPayload(query: unknown): Promise<unknown> {
  return os("POST", `/${index}/_search`, {
    size: 50,
    track_total_hits: true,
    _source: ["post_id"],
    query,
    sort: [{ _score: "desc" }, { created: "desc" }],
  });
}

function hasPhraseType(query: unknown): boolean {
  if (Array.isArray(query)) return query.some((item) => hasPhraseType(item));
  if (!query || typeof query !== "object") return false;
  for (const [key, child] of Object.entries(query as Record<string, unknown>)) {
    if (key === "type" && child === "phrase") return true;
    if (hasPhraseType(child)) return true;
  }
  return false;
}

async function assertSameRanks(label: string, queries: unknown[]): Promise<void> {
  const ranks: string[][] = [];
  for (const query of queries) {
    ranks.push(hitRanks(await searchPayload(query)));
  }
  const first = ranks[0] ?? [];
  assert.ok(first.length > 0, `${label}: expected hits`);
  for (let index = 1; index < ranks.length; index += 1) {
    assert.deepEqual(
      ranks[index],
      first,
      `${label}:\n${first.join(" ")}\n${(ranks[index] ?? []).join(" ")}`,
    );
  }
}

function assertFirst(ids: string[], id: string, label: string): void {
  assert.equal(ids[0], id, `${label}: first was ${ids[0] || "(none)"} [${ids.join(", ")}]`);
}

function assertHas(ids: string[], id: string, label: string): void {
  assert.equal(ids.includes(id), true, `${label}: missing ${id} [${ids.join(", ")}]`);
}

function assertLacks(ids: string[], id: string, label: string): void {
  assert.equal(ids.includes(id), false, `${label}: included ${id} [${ids.join(", ")}]`);
}

function assertBefore(ids: string[], earlier: string, later: string, label: string): void {
  const left = ids.indexOf(earlier);
  const right = ids.indexOf(later);
  assert.ok(
    left !== -1 && right !== -1 && left < right,
    `${label}: expected ${earlier} before ${later} [${ids.join(", ")}]`,
  );
}

async function tokens(analyzer: string, text: string): Promise<string[]> {
  const payload = (await os("POST", `/${index}/_analyze`, { analyzer, text })) as {
    tokens?: Array<{ token: string }>;
  };
  return (payload.tokens ?? []).map((token) => token.token);
}

async function main(): Promise<void> {
  await fetch(`${opensearchUrl}/${index}`, { method: "DELETE" });
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as unknown;
  await os("PUT", `/${index}`, mapping);

  const indexedGroupIds = await tokens("text_index", "groupIds");
  assert.ok(indexedGroupIds.includes("groupid"), indexedGroupIds.join(","));
  assert.ok(indexedGroupIds.includes("group"), indexedGroupIds.join(","));
  assert.ok(indexedGroupIds.includes("id"), indexedGroupIds.join(","));
  assert.deepEqual(await tokens("text_search", "groupIds"), ["group", "id"]);
  const sdkQueryTokens = await tokens("text_search", "SDK3");
  assert.equal(sdkQueryTokens.includes("sdk"), true, sdkQueryTokens.join(","));
  assert.equal(sdkQueryTokens.includes("3"), true, sdkQueryTokens.join(","));
  const phraseTokens = await tokens("text_phrase", "full body tracking");
  assert.equal(phraseTokens.includes("fbt"), false, phraseTokens.join(","));
  assert.equal(phraseTokens.includes("full"), true, phraseTokens.join(","));
  const menuPhraseTokens = await tokens("text_phrase", "the menu");
  assert.equal(menuPhraseTokens.includes("the"), true, menuPhraseTokens.join(","));
  assert.equal(menuPhraseTokens.includes("menu"), true, menuPhraseTokens.join(","));
  const groupPhraseTokens = await tokens("text_phrase", "groupIds");
  assert.equal(groupPhraseTokens.includes("group"), true, groupPhraseTokens.join(","));
  assert.equal(groupPhraseTokens.includes("id"), true, groupPhraseTokens.join(","));
  const exactGroupIds = await tokens("text_exact_index", "groupIds");
  assert.ok(exactGroupIds.includes("groupids"), exactGroupIds.join(","));
  assert.ok(exactGroupIds.includes("group"), exactGroupIds.join(","));
  assert.ok(exactGroupIds.includes("ids"), exactGroupIds.join(","));
  assert.deepEqual(await tokens("text_exact_search", "groupIds"), ["groupids"]);
  assert.deepEqual(await tokens("text_search", "C#"), ["csharp"]);
  assert.deepEqual(await tokens("text_exact_search", "C++"), ["cplusplus"]);
  assert.deepEqual(await tokens("text_search", "C++"), await tokens("text_index", "C++"));
  assert.deepEqual(await tokens("text_exact_search", "vrc+"), ["vrcplus"]);
  assert.deepEqual(await tokens("text_exact_search", "avatr"), ["avatr"]);

  const bulk: string[] = [];
  for (const doc of docs) {
    bulk.push(JSON.stringify({ index: { _id: doc.post_id } }));
    bulk.push(JSON.stringify(withCombined(doc)));
  }
  bulk.push("");
  const bulkResponse = await fetch(`${opensearchUrl}/${index}/_bulk?refresh=true`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: bulk.join("\n"),
  });
  const bulkText = await bulkResponse.text();
  if (!bulkResponse.ok || bulkText.includes('"errors":true')) {
    throw new Error(`bulk index failed ${bulkResponse.status} ${bulkText.slice(0, 800)}`);
  }

  const plain = (q: string) => search(instantSearchStrictQuery(q, textSearchAttributes));
  const lucene = (q: string) => search(buildLuceneQueryBody(q));

  const groupIds = await plain("groupIds");
  assertFirst(groupIds, "exact-groupids", "groupIds");
  assertHas(groupIds, "camel-role", "groupIds groupId stem");
  assertHas(groupIds, "url-doc", "groupIds inside a url");
  assertLacks(groupIds, "group-words", "groupIds");
  assertHas(groupIds, "group-id-words", "groupIds finds spaced group ids");
  assertHas(groupIds, "ids-group", "groupIds finds adjacent ids group");
  assertHas(groupIds, "grop-ids", "groupIds fuzzy typo");
  assertBefore(groupIds, "exact-groupids", "group-id-words", "exact identifier outranks adjacent split");
  assertBefore(groupIds, "group-id-words", "grop-ids", "adjacent split outranks fuzzy typo");
  assertBefore(groupIds, "ids-group", "grop-ids", "reversed adjacent split outranks fuzzy typo");
  assertLacks(groupIds, "group-sentence", "groupIds");
  assertLacks(groupIds, "group-has-id", "groupIds");
  assertLacks(groupIds, "merch", "groupIds");

  const groupIdsCase = await plain("GroupIDs");
  assertFirst(groupIdsCase, "exact-groupids", "GroupIDs");
  assertHas(groupIdsCase, "group-id-words", "GroupIDs");
  assertHas(groupIdsCase, "ids-group", "GroupIDs");
  assertLacks(groupIdsCase, "group-words", "GroupIDs");
  assertLacks(groupIdsCase, "group-sentence", "GroupIDs");
  assertLacks(groupIdsCase, "group-has-id", "GroupIDs");

  const groupWords = await plain("group ids");
  assertFirst(groupWords, "exact-groupids", "group ids");
  assertHas(groupWords, "group-id-words", "group ids");
  assertHas(groupWords, "camel-role", "group ids");
  assertHas(groupWords, "ids-group", "group ids");
  assertHas(groupWords, "group-sentence", "group ids across sentences");
  assertHas(groupWords, "group-has-id", "group ids");
  assertLacks(groupWords, "group-words", "group ids");

  const gropIds = await plain("gropIds");
  assertFirst(gropIds, "grop-ids", "gropIds");
  assertHas(gropIds, "exact-groupids", "gropIds");
  assertBefore(gropIds, "grop-ids", "exact-groupids", "gropIds");
  assertLacks(gropIds, "group-words", "gropIds");

  const gruopIds = await plain("gruopIds");
  assertHas(gruopIds, "exact-groupids", "gruopIds");
  assertLacks(gruopIds, "group-words", "gruopIds");

  const roleIds = await plain("roleIds");
  assertFirst(roleIds, "camel-role", "roleIds");
  assertLacks(roleIds, "exact-groupids", "roleIds");
  assertLacks(roleIds, "group-words", "roleIds");

  const playerId = await plain("playerId");
  assertFirst(playerId, "player", "playerId");
  const playerID = await plain("playerID");
  assertFirst(playerID, "player", "playerID");

  const sdk3 = await plain("SDK3");
  assertFirst(sdk3, "sdk3", "SDK3");
  assertHas(sdk3, "sdk-prose", "SDK3 finds sdk 3");
  assertLacks(sdk3, "sdk-word", "SDK3");
  const sdkAnd3 = await plain("sdk 3");
  assertHas(sdkAnd3, "sdk3", "sdk 3");
  assertHas(sdkAnd3, "sdk-prose", "sdk 3");
  assertLacks(sdkAnd3, "sdk-word", "sdk 3");

  const avatr = await plain("avatr");
  assertFirst(avatr, "avatr-typo", "avatr");
  assertHas(avatr, "avatar-only", "avatr");
  assertHas(avatr, "performance", "avatr");
  assertBefore(avatr, "avatr-typo", "avatar-only", "avatr");
  assertLacks(avatr, "merch", "avatr");

  const opt = await plain("optmization");
  assertFirst(opt, "optmization", "optmization");
  assertHas(opt, "optimization", "optmization");
  assertBefore(opt, "optmization", "optimization", "optmization");

  const avatarPerformance = await plain("avatar performance");
  assertFirst(avatarPerformance, "performance", "avatar performance");
  assertHas(avatarPerformance, "performence", "avatar performance");
  assertBefore(avatarPerformance, "performance", "performence", "avatar performance");
  assertLacks(avatarPerformance, "avatar-only", "avatar performance");
  assertLacks(avatarPerformance, "merch", "avatar performance");

  const phrase = await plain('"full body"');
  assertHas(phrase, "full-body", "quoted full body");
  assertLacks(phrase, "reversed-body", "quoted full body");

  const unquoted = await plain("full body");
  assertHas(unquoted, "full-body", "unquoted full body");
  assertHas(unquoted, "reversed-body", "unquoted full body");

  const csharp = await plain("C#");
  assertHas(csharp, "csharp", "C#");
  assertLacks(csharp, "letter-c", "C#");
  const cplusplus = await plain("C++");
  assertHas(cplusplus, "cplusplus", "C++");
  assertLacks(cplusplus, "letter-c", "C++");

  const vrcPlus = await plain("vrc+");
  assertHas(vrcPlus, "vrcplus", "vrc+");
  assertLacks(vrcPlus, "merch", "vrc+");

  const udonSharp = await plain("UdonSharp");
  assertFirst(udonSharp, "udonsharp", "UdonSharp");

  const luceneGroupIds = await lucene("groupIds");
  assertHas(luceneGroupIds, "exact-groupids", "lucene groupIds");
  assertHas(luceneGroupIds, "camel-role", "lucene groupIds");
  assertLacks(luceneGroupIds, "group-words", "lucene groupIds");
  assertHas(luceneGroupIds, "group-id-words", "lucene groupIds");
  assertHas(luceneGroupIds, "group-sentence", "lucene groupIds");
  assertHas(luceneGroupIds, "group-has-id", "lucene groupIds");

  const luceneStatus = await lucene("status:Open");
  assertHas(luceneStatus, "status-open", "status:Open");
  assertLacks(luceneStatus, "status-closed", "status:Open");
  assertLacks(luceneStatus, "merch", "status:Open");

  const luceneStatusUpper = await lucene("status:OPEN");
  assertHas(luceneStatusUpper, "exact-groupids", "status:OPEN");
  assertLacks(luceneStatusUpper, "status-closed", "status:OPEN");

  const luceneBoard = await lucene("board.urlName:Bug-Reports");
  assertHas(luceneBoard, "exact-groupids", "board.urlName:Bug-Reports");
  assertLacks(luceneBoard, "merch", "board.urlName:Bug-Reports");

  const luceneCsharp = await lucene("C#");
  assertHas(luceneCsharp, "csharp", "lucene C#");
  assertLacks(luceneCsharp, "letter-c", "lucene C#");

  const lucenePlus = await lucene("C++");
  assertHas(lucenePlus, "cplusplus", "lucene C++");
  assertLacks(lucenePlus, "letter-c", "lucene C++");

  const luceneVrc = await lucene("vrc+");
  assertHas(luceneVrc, "vrcplus", "lucene vrc+");
  assertLacks(luceneVrc, "letter-c", "lucene vrc+");

  const luceneUrl = await lucene("http://example.com");
  assertHas(luceneUrl, "url-doc", "lucene url");
  assertLacks(luceneUrl, "merch", "lucene url");

  const lucenePhrase = await lucene('"full body"');
  assertHas(lucenePhrase, "full-body", "lucene phrase");
  assertLacks(lucenePhrase, "reversed-body", "lucene phrase");

  const luceneAnd = await lucene("status:closed AND title:merch");
  assert.deepEqual(luceneAnd, ["merch"]);

  const luceneOr = await lucene("status:open OR status:closed");
  assertHas(luceneOr, "status-open", "status or");
  assertHas(luceneOr, "status-closed", "status or");

  const luceneNot = await lucene("avatar NOT status:closed");
  assertHas(luceneNot, "status-open", "not closed");
  assertLacks(luceneNot, "status-closed", "not closed");
  assertLacks(luceneNot, "merch", "not closed");

  const lucenePinned = await lucene("comments.pinned:True");
  assertHas(lucenePinned, "status-open", "comments.pinned:True");
  assertLacks(lucenePinned, "status-closed", "comments.pinned:True");

  const luceneVote = await lucene("voteSettings.highEngagement:True");
  assert.deepEqual(luceneVote, ["status-open"]);

  const luceneFuzzy = await lucene("groupIds~1");
  assertHas(luceneFuzzy, "exact-groupids", "groupIds~1");
  assertHas(luceneFuzzy, "closed-groupids", "groupIds~1");
  assertLacks(luceneFuzzy, "group-words", "groupIds~1");
  assertLacks(luceneFuzzy, "menu-bare", "groupIds~1");

  const luceneFuzzyAnd = await lucene("status:open AND groupIds~1");
  assertHas(luceneFuzzyAnd, "exact-groupids", "status and fuzzy");
  assertLacks(luceneFuzzyAnd, "menu-bare", "status and fuzzy");
  assertLacks(luceneFuzzyAnd, "group-words", "status and fuzzy");
  assertLacks(luceneFuzzyAnd, "closed-groupids", "status and fuzzy");
  await assertSameRanks("fuzzy and order", [
    buildLuceneQueryBody("status:open AND groupIds~1"),
    buildLuceneQueryBody("groupIds~1 AND status:open"),
  ]);
  const luceneWildAnd = await lucene("status:open AND groupIds*");
  assertHas(luceneWildAnd, "exact-groupids", "status and wildcard");
  assertLacks(luceneWildAnd, "menu-bare", "status and wildcard");
  assertLacks(luceneWildAnd, "group-words", "status and wildcard");
  assertLacks(luceneWildAnd, "closed-groupids", "status and wildcard");
  await assertSameRanks("wildcard and order", [
    buildLuceneQueryBody("status:open AND groupIds*"),
    buildLuceneQueryBody("groupIds* AND status:open"),
  ]);
  const luceneNotFuzzy = await lucene("NOT groupIds~1");
  assertLacks(luceneNotFuzzy, "exact-groupids", "not fuzzy");
  assertHas(luceneNotFuzzy, "menu-bare", "not fuzzy");

  const luceneParen = await lucene("(groupIds");
  assertHas(luceneParen, "exact-groupids", "(groupIds");
  assertLacks(luceneParen, "group-words", "(groupIds");

  const luceneRole = await lucene("title:roleIds");
  assert.deepEqual(luceneRole, ["camel-role"]);

  const plainQuery = (q: string) => instantSearchStrictQuery(q, textSearchAttributes);
  assert.equal(hasPhraseType(plainQuery("group ids")), false);
  assert.equal(hasPhraseType(plainQuery('"full body"')), true);
  for (const [left, right] of [
    ["group ids", "ids group"],
    ["Group IDs", "ids group"],
    ["avatar performance", "performance avatar"],
    ["full body", "body full"],
    ["full body tracking", "tracking body full"],
    ["sdk 3", "3 sdk"],
    ["the menu", "menu the"],
    ["vrchat plus", "plus vrchat"],
    ['avatar "full body"', '"full body" avatar'],
  ] as const) {
    assert.deepEqual(plainQuery(left), plainQuery(right), `${left} vs ${right}`);
    await assertSameRanks(left, [plainQuery(left), plainQuery(right)]);
  }

  const tracking = await plain("full body tracking");
  assertHas(tracking, "fbt-only", "full body tracking synonym");
  assertHas(tracking, "full-body", "full body tracking");
  assert.deepEqual(await plain("tracking body full"), tracking);
  const unquotedBody = await plain("full body");
  assertLacks(unquotedBody, "fbt-only", "full body is not the fbt phrase");
  assert.deepEqual(await plain("body full"), unquotedBody);

  const quotedForward = await plain('"full body"');
  const quotedReverse = await plain('"body full"');
  assert.notDeepEqual(quotedForward, quotedReverse);
  assertHas(quotedForward, "full-body", "quoted phrase order");
  assertLacks(quotedReverse, "full-body", "quoted phrase order");
  const mixedForward = await plain('avatar "full body"');
  const mixedReversePhrase = await plain('avatar "body full"');
  assert.deepEqual(mixedForward, await plain('"full body" avatar'));
  assert.notDeepEqual(mixedForward, mixedReversePhrase);

  await assertSameRanks("lucene fields", [
    buildLuceneQueryBody("status:open board.urlName:bug-reports"),
    buildLuceneQueryBody("board.urlName:bug-reports status:open"),
  ]);
  await assertSameRanks("lucene and", [
    buildLuceneQueryBody("status:open AND title:avatar"),
    buildLuceneQueryBody("title:avatar AND status:open"),
  ]);
  await assertSameRanks("lucene or", [
    buildLuceneQueryBody("status:open OR status:closed"),
    buildLuceneQueryBody("status:closed OR status:open"),
  ]);
  await assertSameRanks("lucene precedence", [
    buildLuceneQueryBody("title:avatar AND status:open OR status:closed"),
    buildLuceneQueryBody("status:closed OR status:open AND title:avatar"),
  ]);
  await assertSameRanks("lucene not", [
    buildLuceneQueryBody("avatar NOT status:closed"),
    buildLuceneQueryBody("NOT status:closed AND avatar"),
  ]);
  const luceneQuoted = await lucene('"full body"');
  const luceneQuotedReverse = await lucene('"body full"');
  assert.notDeepEqual(luceneQuoted, luceneQuotedReverse);
  assertHas(luceneQuoted, "full-body", "lucene quoted order");
  assertLacks(luceneQuotedReverse, "full-body", "lucene quoted order");

  assert.deepEqual(plainQuery("the"), { match_all: {} });
  assert.deepEqual(plainQuery("the a an"), { match_all: {} });
  assert.deepEqual(plainQuery("the menu"), plainQuery("menu"));
  assert.deepEqual(plainQuery("not working"), plainQuery("working"));
  assert.deepEqual(plainQuery("there menu"), plainQuery("menu"));
  const theMenu = await plain("the menu");
  assertHas(theMenu, "menu-bare", "the menu");
  assertHas(theMenu, "menu-bug", "the menu");
  assertHas(theMenu, "menu-only", "the menu");
  assertHas(theMenu, "menu-load", "the menu");
  const theOnly = hitRanks(await searchPayload(plainQuery("the")));
  assert.equal(
    theOnly.some((rank) => rank.startsWith("menu-bare@")),
    true,
    theOnly.join(" "),
  );
  assert.equal(
    theOnly.every((rank) => rank.endsWith("@1")),
    true,
    theOnly.join(" "),
  );
  const notWorking = await plain("not working");
  assertHas(notWorking, "working-only", "not working");
  assertLacks(notWorking, "merch", "not working");

  const quotedTracking = await plain('"full body tracking"');
  assertHas(quotedTracking, "full-body", "quoted full body tracking");
  assertLacks(quotedTracking, "fbt-only", "quoted full body tracking");
  assertLacks(quotedTracking, "reversed-body", "quoted full body tracking");
  const fbt = await plain("fbt");
  assertHas(fbt, "fbt-only", "fbt synonym");
  assertHas(fbt, "full-body", "fbt synonym");
  const camelTracking = await plain("fullBodyTracking");
  assertFirst(camelTracking, "full-body-camel", "fullBodyTracking");
  assertHas(camelTracking, "fbt-only", "fullBodyTracking synonym");
  assertHas(camelTracking, "full-body", "fullBodyTracking adjacent phrase");
  assertBefore(camelTracking, "full-body-camel", "fbt-only", "fullBodyTracking");
  assertBefore(camelTracking, "full-body", "fbt-only", "fullBodyTracking adjacent before synonym");
  assertHas(camelTracking, "reversed-body", "fullBodyTracking synonym");
  const trackingCamelReverse = await plain("trackingBodyFull");
  assertHas(trackingCamelReverse, "fbt-only", "trackingBodyFull synonym");
  assertHas(trackingCamelReverse, "full-body", "trackingBodyFull");
  assertHas(trackingCamelReverse, "full-body-camel", "trackingBodyFull");
  assertBefore(
    trackingCamelReverse,
    "full-body",
    "fbt-only",
    "trackingBodyFull adjacent before synonym",
  );
  assertBefore(
    trackingCamelReverse,
    "full-body-camel",
    "fbt-only",
    "trackingBodyFull camel before synonym",
  );
  const endOfLine = await plain("endOfLine");
  assertFirst(endOfLine, "end-of-line-camel", "endOfLine");
  assertHas(endOfLine, "end-of-line", "endOfLine matches end of line");
  assertHas(endOfLine, "end-line", "endOfLine matches adjacent end line");
  assertLacks(endOfLine, "end-foo-line", "endOfLine");
  assertLacks(endOfLine, "end-sentence", "endOfLine");
  const endLine = await plain("end line");
  assertHas(endLine, "end-of-line", "end line bag");
  assertHas(endLine, "end-foo-line", "end line bag");
  assertHas(endLine, "end-sentence", "end line bag");
  const quotedEnd = await plain('"end of line"');
  assertHas(quotedEnd, "end-of-line", "quoted end of line");
  assertHas(quotedEnd, "end-of-line-camel", "quoted end of line");
  assertLacks(quotedEnd, "end-line", "quoted end of line");
  assertLacks(quotedEnd, "end-foo-line", "quoted end of line");

  const luceneTracking = await lucene('"full body tracking"');
  assertHas(luceneTracking, "full-body", "lucene quoted tracking");
  assertLacks(luceneTracking, "fbt-only", "lucene quoted tracking");
  assertLacks(luceneTracking, "reversed-body", "lucene quoted tracking");
  const luceneTitleTracking = await lucene('title:"full body tracking"');
  assert.deepEqual(luceneTitleTracking, ["full-body", "full-body-camel"]);
  const luceneOrPhrase = await lucene('status:closed OR title:"full body tracking"');
  assertHas(luceneOrPhrase, "full-body", "or phrase");
  assertHas(luceneOrPhrase, "merch", "or phrase");
  assertHas(luceneOrPhrase, "status-closed", "or phrase");
  assertLacks(luceneOrPhrase, "fbt-only", "or phrase");
  const quotedMenu = await plain('"the menu"');
  assertHas(quotedMenu, "menu-bug", "quoted the menu");
  assertHas(quotedMenu, "menu-only", "quoted the menu");
  assertLacks(quotedMenu, "menu-bare", "quoted the menu");
  assertLacks(quotedMenu, "menu-load", "quoted the menu");
  const quotedGroup = await plain('"group ids"');
  assertHas(quotedGroup, "exact-groupids", "quoted group ids");
  assertHas(quotedGroup, "group-id-words", "quoted group ids");
  assertLacks(quotedGroup, "group-sentence", "quoted group ids");
  assertLacks(quotedGroup, "group-has-id", "quoted group ids");
  assertLacks(quotedGroup, "ids-group", "quoted group ids");
  assertLacks(quotedGroup, "group-words", "quoted group ids");

  const statusGroup = await lucene("status:(Open OR Closed)");
  assertHas(statusGroup, "status-open", "status group case");
  assertHas(statusGroup, "status-closed", "status group case");
  assertHas(statusGroup, "merch", "status group case");
  await assertSameRanks("status group case", [
    buildLuceneQueryBody("status:(Open OR Closed)"),
    buildLuceneQueryBody("status:(open OR closed)"),
  ]);
  const statusRange = await lucene("status:[Closed TO Open]");
  assertHas(statusRange, "status-open", "status range case");
  assertHas(statusRange, "status-closed", "status range case");
  await assertSameRanks("status range case", [
    buildLuceneQueryBody("status:[Closed TO Open]"),
    buildLuceneQueryBody("status:[closed TO open]"),
  ]);
  const pinnedGroup = await lucene("comments.pinned:(True)");
  assertHas(pinnedGroup, "status-open", "pinned group case");
  assertLacks(pinnedGroup, "status-closed", "pinned group case");

  const agentForward = parseAgentSearchQuery({
    q: "group",
    board: "bug-reports",
    status: "open",
  });
  const agentReverse = parseAgentSearchQuery({
    status: "open",
    q: "group",
    board: "bug-reports",
  });
  assert.deepEqual(agentForward, agentReverse);
  assert.equal(agentForward.ok, true);
  if (!agentForward.ok) {
    throw new Error("expected agent query to parse");
  }
  const agentBody = buildAgentSearchBody(agentForward.params);
  const agentQuery = agentBody.query;
  const swappedAgent = {
    bool: {
      must: (agentQuery as { bool: { must: unknown[] } }).bool.must,
      filter: [...((agentQuery as { bool: { filter: unknown[] } }).bool.filter ?? [])].reverse(),
    },
  };
  await assertSameRanks("agent filters", [agentQuery, swappedAgent]);

  const gateway = API(searchkitConfig(opensearchUrl, "admin", "admin"));
  async function uiRanks(
    facetFilters: unknown,
    numericFilters?: string[],
  ): Promise<string[]> {
    const response = await gateway.handleRequest(
      [
        {
          indexName: `${index}_relevance_desc`,
          params: {
            query: "group",
            hitsPerPage: 30,
            facetFilters,
            ...(numericFilters ? { numericFilters } : {}),
          },
        },
      ],
      { getQuery: instantSearchStrictQuery },
    );
    const result = response.results[0];
    if (!result || !("hits" in result)) {
      throw new Error("website search returned no hits");
    }
    return result.hits.map((hit) => `${hit.objectID}@${hit._score ?? 0}`);
  }
  const relevanceTied = await gateway.handleRequest(
    [
      {
        indexName: `${index}_relevance_desc`,
        params: { query: "the", hitsPerPage: 100 },
      },
    ],
    { getQuery: instantSearchStrictQuery },
  );
  const relevanceResult = relevanceTied.results[0];
  if (!relevanceResult || !("hits" in relevanceResult)) {
    throw new Error("relevance tiebreak search returned no hits");
  }
  const tiedHits = relevanceResult.hits.map((hit) => {
    const row = hit as { post_id?: string; created?: string; _score?: number };
    return {
      id: row.post_id ?? "",
      created: row.created ?? "",
      score: row._score ?? 0,
    };
  });
  assert.ok(tiedHits.length > 1, "relevance tiebreak expected more than one hit");
  assert.equal(
    tiedHits.every((hit) => hit.score === tiedHits[0]?.score),
    true,
    tiedHits.map((hit) => `${hit.id}@${hit.score}`).join(" "),
  );
  for (let hitIndex = 1; hitIndex < tiedHits.length; hitIndex += 1) {
    const previous = tiedHits[hitIndex - 1];
    const current = tiedHits[hitIndex];
    assert.ok(
      previous && current && previous.created >= current.created,
      `relevance tiebreak: ${previous?.id} ${previous?.created} before ${current?.id} ${current?.created}`,
    );
  }
  assert.deepEqual(
    tiedHits.filter((hit) => hit.id.startsWith("menu-")).map((hit) => hit.id),
    ["menu-load", "menu-only", "menu-bug", "menu-bare"],
  );

  const facetsForward = await uiRanks([["status:open"], ["board_slug:bug-reports"]]);
  const facetsReverse = await uiRanks([["board_slug:bug-reports"], ["status:open"]]);
  assert.ok(facetsForward.length > 1, facetsForward.join(" "));
  assert.deepEqual(facetsReverse, facetsForward);
  const valuesForward = await uiRanks([["status:open", "status:closed"]]);
  const valuesReverse = await uiRanks([["status:closed", "status:open"]]);
  assert.ok(valuesForward.length > 1, valuesForward.join(" "));
  assert.deepEqual(valuesReverse, valuesForward);
  const numericForward = await uiRanks(undefined, ["score>=5", "commentCount>=2"]);
  const numericReverse = await uiRanks(undefined, ["commentCount>=2", "score>=5"]);
  assert.ok(numericForward.length > 1, numericForward.join(" "));
  assert.deepEqual(numericReverse, numericForward);
  assert.equal(numericForward.some((hit) => hit.startsWith("exact-groupids@")), true);
  assert.equal(numericForward.some((hit) => hit.startsWith("group-words@")), false);

  const oldIndex = `${index}-oldmap`;
  await fetch(`${opensearchUrl}/${oldIndex}`, { method: "DELETE" });
  const created = await fetch(`${opensearchUrl}/${oldIndex}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          analyzer: {
            text_index: { tokenizer: "standard", filter: ["lowercase"] },
          },
        },
      },
      mappings: { properties: { title: { type: "text", analyzer: "text_index" } } },
    }),
  });
  if (!created.ok) {
    throw new Error(`old mapping create failed ${created.status} ${await created.text()}`);
  }
  async function phraseStatus(indexName: string, mode: PhraseMode): Promise<{ status: number; body: string }> {
    const response = await fetch(`${opensearchUrl}/${indexName}/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: {
          multi_match: {
            query: "full body",
            type: "phrase",
            fields: phraseSearchFields(["title"], mode),
            analyzer: phraseAnalyzer(mode),
          },
        },
      }),
    });
    return { status: response.status, body: await response.text() };
  }
  try {
    const oldModes: PhraseMode[] = [];
    const recovered = await withPhraseFallback(async (mode) => {
      oldModes.push(mode);
      const result = await phraseStatus(oldIndex, mode);
      if (result.status === 400) {
        throw new Error(result.body);
      }
      if (result.status !== 200) {
        throw new Error(result.body);
      }
      return result;
    }, (error) => (error instanceof Error ? error.message : undefined));
    assert.deepEqual(oldModes, ["strict", "compatible"]);
    assert.equal(recovered.status, 200, recovered.body);

    const swappedModes: PhraseMode[] = [];
    const swapped = await withPhraseFallback(async (mode) => {
      swappedModes.push(mode);
      const result = await phraseStatus(index, mode);
      if (result.status === 400) {
        throw new Error(result.body);
      }
      if (result.status !== 200) {
        throw new Error(result.body);
      }
      return result;
    }, (error) => (error instanceof Error ? error.message : undefined));
    assert.deepEqual(swappedModes, ["strict"]);
    assert.equal(swapped.status, 200, swapped.body);
  } finally {
    await fetch(`${opensearchUrl}/${oldIndex}`, { method: "DELETE" });
  }

  console.info("search ranking tests passed");
}

await main();
