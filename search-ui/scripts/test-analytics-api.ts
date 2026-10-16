import assert from "node:assert/strict";
import { AnalyticsError, createAnalyticsService, parseAnalyticsParams, scanAnalyticsPosts } from "../server/analytics-api";
import { getCurrentSearchFilterKey, setCurrentSearchParams, subscribeCurrentSearchParams } from "../src/searchFilterStore";

assert.throws(() => parseAnalyticsParams(null), AnalyticsError);
assert.throws(() => parseAnalyticsParams({ params: { query: [] } }), /Invalid query/);
assert.throws(() => parseAnalyticsParams({ params: { numericFilters: [["score > 3"]] } }), /Invalid numericFilters/);
assert.throws(() => parseAnalyticsParams({ params: { filters: "x".repeat(17_000) } }), /too large/);
assert.deepEqual(parseAnalyticsParams({ params: { query: "avatar", page: 50, hitsPerPage: 1, facetFilters: [["status:tracked", "status:complete"]], numericFilters: ["score > 5"], indexName: "private", _source: ["author"] } }), { query: "avatar", facetFilters: [["status:tracked", "status:complete"]], numericFilters: ["score > 5"] });
let changes = 0;
const unsubscribe = subscribeCurrentSearchParams(() => changes++);
setCurrentSearchParams({ query: "avatar", facetFilters: ["status:tracked"], page: 0 });
const firstKey = getCurrentSearchFilterKey();
setCurrentSearchParams({ query: "avatar", facetFilters: ["status:tracked"], page: 7 });
assert.equal(getCurrentSearchFilterKey(), firstKey);
assert.equal(changes, 1, "pagination does not retrigger analytics");
setCurrentSearchParams({ query: "avatar", facetFilters: ["status:closed"] });
assert.equal(changes, 2);
unsubscribe();

const originalFetch = globalThis.fetch;
const target = { opensearchUrl: "http://search.test", opensearchUser: "test", opensearchPassword: "test", index: "feedback-posts-generation" };
const query = { nested: { path: "comments", inner_hits: {}, query: { term: { "comments.pinned": true } } } };
const calls: Array<{ url: string; method: string; body: any }> = [];
let total = 602;
let failPage = false;
let repeatPage = false;
let incompletePage = false;
globalThis.fetch = async (url, init) => {
  const call = { url: String(url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) };
  calls.push(call);
  const second = Boolean(call.body.search_after);
  const start = second && !repeatPage ? Number(call.body.search_after[0]) + 1 : 0;
  const data = second && failPage ? { timed_out: true } : { hits: {
    ...(second ? {} : { total: { value: total, relation: "eq" } }),
    hits: Array.from({ length: second && incompletePage ? 0 : Math.max(0, Math.min(500, total - start)) }, (_, i) => {
      const id = String(i + start).padStart(4, "0");
      return { _source: { post_id: id, created: "2020-01-01T00:00:00Z", status: "tracked" }, sort: [id] };
    }),
  } };
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  const posts = await scanAnalyticsPosts(target, query);
  assert.equal(posts.length, 602, "scan covers every page, not just the first 500 results");
  assert.match(calls[0]!.url, /feedback-posts-generation/);
  assert.equal(calls[0]!.body.query.nested.inner_hits, undefined);
  assert.equal(calls[0]!.body.query.nested.query.term["comments.pinned"], true);
  assert.equal(calls[0]!.body._source.some((field: string) => /author|voter|value|details/.test(field)), false);
  assert.deepEqual(calls[0]!.body.sort, [{ post_id: "asc" }]);
  assert.deepEqual(calls[1]!.body.search_after, ["0499"]);
  assert.equal(calls[1]!.body.track_total_hits, false, "count the cohort only on the first page");
  assert.equal(calls.every(call => call.method === "POST" && call.url.endsWith("/_search") && !call.url.includes("scroll")), true, "scan uses ordinary searches without scroll contexts");
  failPage = true; calls.length = 0;
  await assert.rejects(scanAnalyticsPosts(target, query), /incomplete/);
  failPage = false; repeatPage = true;
  await assert.rejects(scanAnalyticsPosts(target, query), /repeated/);
  repeatPage = false; incompletePage = true;
  await assert.rejects(scanAnalyticsPosts(target, query), /incomplete/);
  incompletePage = false; total = 100_001; calls.length = 0;
  await assert.rejects(scanAnalyticsPosts(target, query), (error: unknown) => error instanceof AnalyticsError && error.status === 422);
  assert.equal(calls.length, 1);
  total = 0; calls.length = 0;
  assert.deepEqual(await scanAnalyticsPosts(target, query), []);

  total = 2; calls.length = 0;
  let generation = "generation-a";
  let compiled = 0;
  const service = createAnalyticsService({ target, resolveIndex: async () => generation, compile: async () => { compiled++; return { match_all: {} }; } });
  const [a, b] = await Promise.all([service({}, false), service({}, false)]);
  assert.equal(a, b, "concurrent identical filters share a result");
  assert.equal(compiled, 1);
  await service({}, false); assert.equal(compiled, 1);
  generation = "generation-b";
  const next = await service({}, false);
  assert.equal(next.index, "generation-b"); assert.equal(compiled, 2, "alias changes invalidate cache");
  await service({}, true); assert.equal(compiled, 3, "Lucene and plain filters have separate caches");
} finally { globalThis.fetch = originalFetch; }
console.info("analytics API, stateless paging, cache, and filter-store tests passed");
