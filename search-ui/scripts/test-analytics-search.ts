import assert from "node:assert/strict";
import { createAnalyticsService, parseAnalyticsParams } from "../server/analytics-api";
import { createSearchService } from "../server/search-service";
import { bulkIndex, deleteIndex, recreateIndex, searchUrl } from "./opensearch-harness";

const index = `feedback-analytics-test-${process.pid}`;
const target = { index, opensearchUrl: searchUrl(), opensearchUser: "test", opensearchPassword: "test" };
const search = createSearchService(target);
const analytics = createAnalyticsService({ target, resolveIndex: async () => index, compile: search.compile });
const statuses = ["tracked", "complete", "closed"];
const docs = Array.from({ length: 610 }, (_, i) => ({
  post_id: String(i), title: i % 5 ? "World lighting" : "Avatar lighting", details: "Lighting report", combined_text: i % 5 ? "World lighting report" : "Avatar lighting report",
  board: { name: i % 2 ? "Features" : "Bugs", urlName: i % 2 ? "features" : "bugs" },
  category: { name: i % 2 ? "Client" : "SDK" }, score: i, commentCount: 2,
  status: statuses[i % 3], created: "2020-01-01T00:00:00.000Z", statusChanged: "2020-01-04T00:00:00.000Z",
  urlName: `ticket-${i}`, voters: [{ name: i % 4 ? "Another Voter" : "Selected Voter" }],
  comments: [
    { _id: `tracked-${i}`, statusChangeID: `tracked-${i}`, statusChangeNewStatus: "tracked", created: "2020-01-02T00:00:00.000Z", author: { name: "Alice" }, pinned: i % 2 === 0, likeCount: i % 10 },
    { _id: `current-${i}`, statusChangeID: `current-${i}`, statusChangeNewStatus: statuses[i % 3], created: "2020-01-04T00:00:00.000Z", author: { name: "Bob" }, value: "Status changed" },
  ],
}));

await recreateIndex(index);
try {
  await bulkIndex(index, docs);
  const cases: Array<{ name: string; params: Record<string, unknown>; lucene?: boolean }> = [
    { name: "all matches, including more than one scroll page", params: {} },
    { name: "plain text", params: { query: "avatar" } },
    { name: "board, OR statuses, and score range", params: { facetFilters: ["board_slug:bugs", ["status:tracked", "status:complete"]], numericFilters: ["score >= 100", "score <= 500"] } },
    { name: "nested voter", params: { facetFilters: ["voter_name:Selected Voter"] } },
    { name: "nested comment facets and numeric range", params: { facetFilters: ["comment_author_name:Alice", "comment_pinned:true"], numericFilters: ["comment_likeCount >= 5"] } },
    { name: "post date range", params: { numericFilters: [`post_created >= ${Date.parse("2019-01-01T00:00:00Z")}`, `post_created <= ${Date.parse("2020-01-02T00:00:00Z")}`], facetFilters: ["category_name:SDK"] } },
    { name: "filter expression", params: { filters: "status:tracked OR status:complete" } },
    { name: "Lucene current status and score", lucene: true, params: { query: "status:tracked AND score:[100 TO 500]" } },
    { name: "Lucene nested field", lucene: true, params: { query: "comments.author.name:Alice AND board.urlName:bugs" } },
    { name: "empty cohort", params: { facetFilters: ["status:nonexistent"] } },
    { name: "presentation parameters do not restrict the cohort", params: { page: 100, hitsPerPage: 1, facets: ["status"], facetFilters: ["status:closed"] } },
  ];
  for (const test of cases) {
    const params = parseAnalyticsParams({ params: test.params });
    const response = await search.search(Boolean(test.lucene), [{ indexName: index, params: { ...params, hitsPerPage: 1000, page: 0 } }]);
    const results = response.body as unknown as { results: Array<{ nbHits: number; hits: Array<{ status: string }> }> };
    const report = await analytics(params, Boolean(test.lucene));
    const hits = results.results[0]!;
    assert.equal(report.total, hits.nbHits, test.name);
    const counts: Record<string, number> = {};
    hits.hits.forEach((hit) => { counts[hit.status] = (counts[hit.status] ?? 0) + 1; });
    assert.deepEqual(Object.fromEntries(report.current.map((row) => [row.status, row.count])), counts, `${test.name}: membership by status`);
    assert.equal(report.current.reduce((sum, row) => sum + row.count, 0), report.total);
  }
  console.info("analytics / Posts filter parity passed against OpenSearch (11 cases, 610 tickets)");
} finally { await deleteIndex(index); }
