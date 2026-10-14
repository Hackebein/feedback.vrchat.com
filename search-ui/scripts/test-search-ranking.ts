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
  instantSearchStrictQuery,
  searchkitConfig,
  textSearchAttributes,
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

const groupIdsQuery = instantSearchStrictQuery("groupIds", textSearchAttributes);
const fuzziness = fuzzinessValues(groupIdsQuery);
assert.deepEqual(
  fuzziness.filter((value) => value !== "0"),
  ["AUTO:5,100"],
  `fuzzy clause should be edit-distance 1 for normal identifier lengths, got ${fuzziness.join(",")}`,
);
assert.equal(fuzziness.includes("AUTO"), false);
const boosts = constantBoosts(groupIdsQuery);
assert.ok(boosts.length >= 2, `expected exact and fuzzy score bands, got ${boosts.join(",")}`);
assert.ok(Math.max(...boosts) >= 100);
assert.ok(Math.min(...boosts) <= 10);
assert.ok(Math.max(...boosts) > Math.min(...boosts) * 10);

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
  assertLacks(groupIds, "merch", "groupIds");

  const groupIdsCase = await plain("GroupIDs");
  assertFirst(groupIdsCase, "exact-groupids", "GroupIDs");
  assertHas(groupIdsCase, "group-id-words", "GroupIDs");
  assertLacks(groupIdsCase, "group-words", "GroupIDs");

  const groupWords = await plain("group ids");
  assertFirst(groupWords, "exact-groupids", "group ids");
  assertHas(groupWords, "group-id-words", "group ids");
  assertHas(groupWords, "camel-role", "group ids");
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
  assertLacks(luceneFuzzy, "group-words", "groupIds~1");

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

  const luceneTracking = await lucene('"full body tracking"');
  assertHas(luceneTracking, "full-body", "lucene quoted tracking");
  assertLacks(luceneTracking, "fbt-only", "lucene quoted tracking");
  assertLacks(luceneTracking, "reversed-body", "lucene quoted tracking");
  const luceneTitleTracking = await lucene('title:"full body tracking"');
  assert.deepEqual(luceneTitleTracking, ["full-body"]);

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

  console.info("search ranking tests passed");
}

await main();
