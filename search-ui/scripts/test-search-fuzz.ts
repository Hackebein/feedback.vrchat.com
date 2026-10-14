/**
 * Property tests for the gateway query builder and the private-board matcher.
 *
 * Building a query never throws. A plain query stays inside the clause budget
 * and OpenSearch 2.19.5 does not answer 400 or 500. Swapping unquoted terms
 * does not change the query or the ranking. Where the two matchers are
 * comparable (no stemming, no synonym expansion), they return the same posts.
 *
 * Synonym expansion and the English stemmer stay gateway-only, so those
 * queries are not in the agreement set.
 */
import assert from "node:assert/strict";
import fc from "fast-check";
import { privateMatchScore, filterPrivatePosts, toStoredPost } from "../../feedback-search-bridge/src/core/private-search";
import type { StoredPrivatePost } from "../../feedback-search-bridge/src/core/private-store";
import { buildLuceneQueryBody } from "../server/lucene-query";
import {
  PLAIN_CLAUSE_BUDGET,
  instantSearchStrictQuery,
  plainQueryClauseEstimate,
  textSearchAttributes,
} from "../server/searchkit-config";
import {
  analyzeTokens,
  bulkIndex,
  deleteIndex,
  recreateIndex,
  saturatedCorpus,
  searchQuery,
  searchUrl,
} from "./opensearch-harness";

const seed = Number(process.env.SEARCH_FUZZ_SEED ?? "20261014");
const pureRuns = Number(process.env.SEARCH_FUZZ_RUNS ?? "60");
const osRuns = Number(process.env.SEARCH_FUZZ_OS_RUNS ?? "20");
const index = "feedback-search-fuzz";

const semantic = [
  { post_id: "alpha-widget", title: "alpha widget", details: "plain alpha widget post" },
  { post_id: "widget-alpha", title: "widget alpha extra", details: "reversed words" },
  { post_id: "alphb", title: "alphb token", details: "one edit from alpha" },
  { post_id: "groupids", title: "Expose groupIds", details: "the groupIds field" },
  { post_id: "group-ids-spaced", title: "Show the group ids", details: "print group ids" },
  { post_id: "group-far", title: "group", details: "sentence two has ids" },
  { post_id: "grop-ids", title: "gropIds typo", details: "someone wrote gropIds" },
  { post_id: "menu", title: "Menu does not load", details: "not working" },
  { post_id: "quiet", title: "Quiet card", details: "nothing about the menu" },
  { post_id: "zebra", title: "Zebra stable", details: "unrelated animal" },
  { post_id: "csharp", title: "Use C# in Udon", details: "csharp sample" },
  { post_id: "cplusplus", title: "Use C++ today", details: "native plugin" },
  { post_id: "url", title: "See http://example.com/path", details: "link only" },
  { post_id: "end-line", title: "end line", details: "no stop word" },
  { post_id: "end-of-line", title: "end of line", details: "with stop" },
  { post_id: "end-foo-line", title: "end foo line", details: "a different hole" },
  { post_id: "ab-c", title: "ab c together", details: "adjacent split" },
  { post_id: "a-bc", title: "a bc together", details: "other split" },
  { post_id: "group-of-ids", title: "group of ids", details: "stop word in the hole" },
  { post_id: "group-the-ids", title: "group the ids", details: "different stop word" },
  { post_id: "end-the-line", title: "end the line", details: "different stop word" },
  { post_id: "xml-ident", title: "XMLHttpRequest", details: "one identifier" },
  { post_id: "xml-pair", title: "XMLHttp Request", details: "index split" },
  { post_id: "xml-spaced", title: "XML Http Request", details: "acronym split" },
  { post_id: "http-ident", title: "HTTPResponse", details: "no camel boundary" },
  { post_id: "http-spaced", title: "HTTP Response", details: "two words" },
  { post_id: "simple-ident", title: "simpleXMLParser", details: "acronym in the middle" },
  { post_id: "simple-pair", title: "simple xmlparser", details: "index split" },
  { post_id: "simple-spaced", title: "simple XML parser", details: "three words" },
];

const stored: StoredPrivatePost[] = semantic.map((doc, index) =>
  toStoredPost(
    {
      _id: doc.post_id,
      urlName: doc.post_id,
      title: doc.title,
      details: doc.details,
      status: "open",
      created: `2099-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    },
    "bug-reports",
  ),
);
const semanticIds = new Set(stored.map((post) => post._id));

const nasty = [
  "",
  "   ",
  "the",
  "the a an",
  "C++",
  "C#",
  "vrc+",
  "http://example.com/a?b=1&c=2",
  '"foo',
  'foo"',
  '"""',
  "((((groupIds",
  "groupIds))))",
  "日本語",
  "🙂",
  "café",
  "alpha\u200bwidget",
  "alpha\0widget",
  "AND OR NOT + - && || ! ~ * ? ^",
  "status:Open",
  "groupIds~1",
  "SDK3",
  "endOfLine",
  "a".repeat(5000),
  Array.from({ length: 80 }, (_, i) => `token${i}abcd`).join(" "),
  `${"(".repeat(5000)}groupIds${")".repeat(5000)}`,
  `${"NOT ".repeat(4000)}avatar`,
  "full body tracking face tracking frame rate",
];

function plain(query: string): void {
  const built = instantSearchStrictQuery(query, textSearchAttributes);
  assert.equal(typeof built, "object");
  assert.ok(plainQueryClauseEstimate(query) <= PLAIN_CLAUSE_BUDGET, query.slice(0, 80));
}

function buildBoth(query: string): void {
  plain(query);
  buildLuceneQueryBody(query);
  const post = stored[0]?.payload ?? { title: "alpha" };
  privateMatchScore(post, query, false);
  privateMatchScore(post, query, true);
}

for (const query of nasty) {
  buildBoth(query);
}

const queryArb = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ minLength: 500, maxLength: 4000 }),
  fc.integer({ min: 0, max: 6000 }).map((count) => "(".repeat(count) + "groupIds" + ")".repeat(count)),
  fc.integer({ min: 0, max: 4000 }).map((count) => `${"NOT ".repeat(count)}avatar`),
  fc.constantFrom(...nasty),
  fc.array(
    fc.constantFrom("the", "and", "C++", "C#", "groupIds", "endOfLine", "http://example.com", "SDK3", "vrc+", "full", "body", "tracking"),
    { minLength: 1, maxLength: 12 },
  ).map((parts) => parts.join(" ")),
);

await fc.assert(fc.property(queryArb, (query) => buildBoth(query)), {
  numRuns: pureRuns,
  seed,
});

function privateIds(query: string): string[] {
  return filterPrivatePosts(stored, { textSearch: query }, { luceneMode: false })
    .map((post) => post._id)
    .sort();
}

function semanticHits(ranks: string[]): string[] {
  return ranks
    .map((rank) => rank.slice(0, rank.lastIndexOf("@")))
    .filter((id) => semanticIds.has(id))
    .sort();
}

async function assertAgree(query: string, expected?: readonly string[]): Promise<void> {
  const result = await searchQuery(
    index,
    instantSearchStrictQuery(query, textSearchAttributes),
    100,
  );
  assert.equal(result.status, 200, `${query} ${result.error}`);
  const gateway = semanticHits(result.ranks);
  const local = privateIds(query);
  assert.deepEqual(local, gateway, query);
  if (expected) {
    assert.deepEqual(gateway, [...expected].sort(), query);
  }
}

async function assertUnquotedOrder(left: string, right: string): Promise<void> {
  assert.deepEqual(
    instantSearchStrictQuery(left, textSearchAttributes),
    instantSearchStrictQuery(right, textSearchAttributes),
    `${left} vs ${right}`,
  );
  const forward = await searchQuery(index, instantSearchStrictQuery(left, textSearchAttributes), 100);
  const backward = await searchQuery(index, instantSearchStrictQuery(right, textSearchAttributes), 100);
  assert.equal(forward.status, 200, forward.error);
  assert.equal(backward.status, 200, backward.error);
  assert.deepEqual(forward.ranks, backward.ranks, `${left} vs ${right}`);
  const ranked = (query: string): string[] =>
    stored
      .map((post) => ({ id: post._id, score: privateMatchScore(post.payload, query) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map((row) => `${row.id}@${row.score}`);
  assert.deepEqual(ranked(left), ranked(right), `${left} vs ${right}`);
}

async function main(): Promise<void> {
  const root = await fetch(searchUrl());
  const version = ((await root.json()) as { version?: { number?: string } }).version?.number;
  assert.equal(version, "2.19.5", "fuzz tests run against OpenSearch 2.19.5");

  const { bases, docs: rich } = saturatedCorpus();
  await recreateIndex(index);
  try {
    const semanticDocs = stored.map((post) => ({
      post_id: post._id,
      title: post.payload.title,
      details: post.payload.details,
      status: post.payload.status,
      created: post.payload.created,
      combined_text: post.combinedText,
    }));
    await bulkIndex(index, [...semanticDocs, ...rich]);

    const stable: string[] = [];
    for (const word of ["alpha", "widget", "zebra", "stable", "menu"]) {
      const tokens = await analyzeTokens(index, "text_search", word);
      if (tokens.length === 1 && tokens[0] === word) {
        stable.push(word);
      }
    }
    assert.ok(stable.length >= 4, stable.join(","));

    await assertAgree("groupIds", ["grop-ids", "group-ids-spaced", "groupids"]);
    await assertAgree("group ids", [
      "grop-ids",
      "group-far",
      "group-ids-spaced",
      "group-of-ids",
      "group-the-ids",
      "groupids",
    ]);
    await assertAgree("endOfLine", ["end-line", "end-of-line"]);
    await assertAgree("end of line", ["end-foo-line", "end-line", "end-of-line", "end-the-line"]);
    await assertAgree("XMLHttpRequest", ["xml-ident", "xml-pair"]);
    await assertAgree("HTTPResponse", ["http-ident"]);
    await assertAgree("simpleXMLParser", ["simple-ident", "simple-pair"]);
    await assertAgree("the menu", ["menu", "quiet"]);
    await assertAgree("the", [...semanticIds].sort());
    await assertAgree("C#", ["csharp"]);
    await assertAgree("C++", ["cplusplus"]);
    await assertAgree("http://example.com/path", ["url"]);
    await assertAgree("alpha", ["alpha-widget", "alphb", "widget-alpha"]);

    await assertUnquotedOrder("alpha widget", "widget alpha");
    await assertUnquotedOrder("the menu", "menu the");
    await assertUnquotedOrder('"end of line" zebra', 'zebra "end of line"');
    await assertUnquotedOrder("aBc AbC", "AbC aBc");

    for (const query of [
      bases.slice(0, 8).join(" "),
      Array.from({ length: 80 }, (_, i) => `zz${i}`).join(" "),
      "a".repeat(5000),
      `${"(".repeat(2000)}groupIds`,
      "C++ C# SDK3 endOfLine",
      "http://example.com/a?b=1&c=2",
      ...nasty,
    ]) {
      const result = await searchQuery(index, instantSearchStrictQuery(query, textSearchAttributes), 5);
      assert.equal(result.status, 200, `${JSON.stringify(query).slice(0, 80)} ${result.error}`);
      assert.ok(plainQueryClauseEstimate(query) <= PLAIN_CLAUSE_BUDGET);
    }

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...stable), { minLength: 1, maxLength: 3 }),
        async (words) => {
          const forward = words.join(" ");
          const backward = [...words].reverse().join(" ");
          await assertAgree(forward);
          await assertUnquotedOrder(forward, backward);
        },
      ),
      { numRuns: osRuns, seed },
    );

    const plainArb = fc.oneof(
      fc.string({ maxLength: 120 }),
      fc.constantFrom(...nasty),
      fc.constant(bases.slice(0, 8).join(" ")),
    );
    await fc.assert(
      fc.asyncProperty(plainArb, async (query) => {
        const result = await searchQuery(index, instantSearchStrictQuery(query, textSearchAttributes), 5);
        assert.equal(result.status, 200, `${JSON.stringify(query).slice(0, 120)} ${result.error}`);
      }),
      { numRuns: osRuns, seed: seed + 1 },
    );
  } finally {
    await deleteIndex(index);
  }
  console.info(`search fuzz passed (seed ${seed}, pure ${pureRuns}, opensearch ${osRuns})`);
}

await main();
