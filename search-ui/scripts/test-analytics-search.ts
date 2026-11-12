import assert from "node:assert/strict";
import { NO_AUTHOR_VALUE, POST_AUTHOR_FACET, postAuthorFacetValue } from "../../shared/post-author-facet";
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
    { name: "all matches, including more than one search page", params: {} },
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
  const additional = Array.from({ length: 10_001 }, (_, i) => ({ post_id: `count-${i}`, status: "open", created: "2020-01-01T00:00:00.000Z" }));
  await bulkIndex(index, additional);
  const exact = await search.search(false, [{ indexName: index, params: { hitsPerPage: 0, facets: [] } }]);
  const exactResults = exact.body as unknown as { results: Array<{ nbHits: number }> };
  assert.equal(exactResults.results[0]?.nbHits, docs.length + additional.length, "Posts totals must remain exact above OpenSearch's default 10,000-hit threshold");

  const literalAuthor = postAuthorFacetValue("No author");
  const authorBoard = { name: "Author fixtures", urlName: "author-fixtures" };
  const authorPost = { title: "Author fixture", combined_text: "Author fixture", created: "2020-01-01T00:00:00.000Z", board: authorBoard, status: "open" };
  await bulkIndex(index, [
    { ...authorPost, post_id: "author-null", author: null, postAuthorFacet: NO_AUTHOR_VALUE },
    { ...authorPost, post_id: "author-absent", status: "tracked", postAuthorFacet: NO_AUTHOR_VALUE },
    { ...authorPost, post_id: "author-literal", author: { name: "No author" }, postAuthorFacet: literalAuthor },
    { ...authorPost, post_id: "author-alice", author: { name: "Alice" }, postAuthorFacet: postAuthorFacetValue("Alice") },
    { ...authorPost, post_id: "author-alice-2", author: { name: "Alice" }, postAuthorFacet: postAuthorFacetValue("Alice") },
    { ...authorPost, post_id: "author-other-board", board: { urlName: "another-board" }, postAuthorFacet: NO_AUTHOR_VALUE },
  ]);
  const boardFilter = "board_slug:author-fixtures";
  const missing = `${POST_AUTHOR_FACET}:${NO_AUTHOR_VALUE}`;
  const literal = `${POST_AUTHOR_FACET}:${literalAuthor}`;
  const missingScope = [boardFilter, "status:open", [missing]];
  const combinedScope = [boardFilter, "status:open", [missing, literal]];
  const authorResponse = await search.search(false, [
    { indexName: index, params: { hitsPerPage: 0, facetFilters: [boardFilter], facets: [POST_AUTHOR_FACET, "author_name"] } },
    { indexName: index, params: { query: "fixture", facetFilters: missingScope } },
    { indexName: index, params: { query: "fixture", facetFilters: combinedScope } },
    { indexName: index, params: { facetFilters: [boardFilter, "author_name:No author"] } },
    { indexName: index, params: { facetName: POST_AUTHOR_FACET, facetQuery: "NO AUTHOR", facetFilters: [boardFilter] } },
    { indexName: index, params: { facetName: POST_AUTHOR_FACET, facetQuery: "/", facetFilters: [boardFilter] } },
    { indexName: index, params: { hitsPerPage: 0, facetFilters: [boardFilter, "status:open"], facets: [POST_AUTHOR_FACET], excludeFacet: { attribute: POST_AUTHOR_FACET, values: [NO_AUTHOR_VALUE] } } },
    {
      indexName: index,
      params: {
        hitsPerPage: 0,
        facetFilters: [boardFilter, "status:open"],
        facets: [POST_AUTHOR_FACET],
        maxValuesPerFacet: 1,
      },
    },
  ]);
  const authorResults = (authorResponse.body as unknown as { results: Array<{
    hits: Array<{ post_id: string }>;
    facets: Record<string, Record<string, number>>;
    facetHits: Array<{ value: string; count: number }>;
  }> }).results;
  assert.deepEqual(authorResults[0]?.facets[POST_AUTHOR_FACET], {
    [NO_AUTHOR_VALUE]: 2, [literalAuthor]: 1, [postAuthorFacetValue("Alice")]: 2,
  });
  assert.deepEqual(authorResults[0]?.facets.author_name, { "No author": 1, Alice: 2 });
  assert.deepEqual(authorResults[1]?.hits.map((hit) => hit.post_id), ["author-null"]);
  assert.deepEqual(authorResults[2]?.hits.map((hit) => hit.post_id).sort(), ["author-literal", "author-null"]);
  assert.deepEqual(authorResults[3]?.hits.map((hit) => hit.post_id), ["author-literal"]);
  assert.deepEqual(authorResults[4]?.facetHits.map(({ value, count }) => ({ value, count })), [
    { value: NO_AUTHOR_VALUE, count: 2 }, { value: literalAuthor, count: 1 },
  ]);
  assert.deepEqual(authorResults[5]?.facetHits, []);
  assert.deepEqual(authorResults[6]?.facets[POST_AUTHOR_FACET], { [literalAuthor]: 1, [postAuthorFacetValue("Alice")]: 2 });
  assert.deepEqual(authorResults[7]?.facets[POST_AUTHOR_FACET], {
    [postAuthorFacetValue("Alice")]: 2, [NO_AUTHOR_VALUE]: 1,
  }, "Keep the exact missing-author count when the board and status facets push it below the bucket limit");
  assert.equal((await analytics({ query: "fixture", facetFilters: combinedScope }, false)).total, 2);
  console.info("Post author facets passed against OpenSearch, including literal names, facet search and analytics");
  console.info("analytics / Posts filter parity passed against OpenSearch (11 cases, 610 tickets); exact totals verified above 10,000 tickets");
} finally { await deleteIndex(index); }
