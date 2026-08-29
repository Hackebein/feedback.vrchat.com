import assert from "node:assert/strict";
import { INDEX_NAME } from "../src/core/config";
import {
  isCannySearchRequest,
  mapCannyToGateway,
  mapGatewayToCanny,
  normalizeGatewayHit,
} from "../src/core/mapping";
import {
  DEFAULT_SORT,
  getEffectiveSort,
  REQUESTED_FACETS,
  resetFilterState,
  SEARCH_DEFAULT_SORT,
  setSort,
} from "../src/core/filter-state";
import { stripSearchPostQueries } from "../src/core/ssr-hook";

const cannyBody = {
  textSearch: "avatar performance",
  boardURLNames: ["feature-requests", "bug-reports"],
  currentBoard: "feature-requests",
  pages: 1,
  status: "open",
  sort: "newest",
};

assert.equal(
  isCannySearchRequest(
    "https://feedback.vrchat.com/api/posts/get",
    "POST",
    JSON.stringify(cannyBody),
  )?.textSearch,
  "avatar performance",
);

// Board browsing without a text query is now a list request we take over.
assert.ok(
  isCannySearchRequest(
    "https://feedback.vrchat.com/api/posts/get",
    "POST",
    JSON.stringify({ ...cannyBody, textSearch: "" }),
  ),
);

// A single-post fetch (identifier only, no list controls) is left to Canny.
assert.equal(
  isCannySearchRequest(
    "https://feedback.vrchat.com/api/posts/get",
    "POST",
    JSON.stringify({ id: "abc123" }),
  ),
  null,
);

// The URL board / status no longer scope the list: without explicit sidebar
// selections the gateway request carries no facetFilters at all.
const gatewayRequest = mapCannyToGateway(cannyBody, false);
assert.match(gatewayRequest.url, /\/api\/search$/);
assert.deepEqual(gatewayRequest.requestBody, [
  {
    indexName: "feedback-posts",
    params: {
      query: "avatar performance",
      hitsPerPage: 10,
      page: 0,
      facets: REQUESTED_FACETS,
      maxValuesPerFacet: 200,
    },
  },
]);

// With explicit sidebar selections, facetFilters and numericFilters come from
// the filter state and board scoping is driven by the picked board names.
const filteredRequest = mapCannyToGateway(
  {
    ...cannyBody,
    filters: {
      refinements: { board_name: ["Bug Reports"], status: ["open", "tracked"] },
      ranges: { score: { min: 5 }, post_created: { max: 1700000000000 } },
      toggles: { vote_highEngagement: true },
      sort: "score_desc",
    },
  },
  false,
);
const filteredParams = (filteredRequest.requestBody as Array<{
  indexName: string;
  params: Record<string, unknown>;
}>)[0];
assert.equal(filteredParams.indexName, "feedback-posts_score_desc");
assert.deepEqual(filteredParams.params.facetFilters, [
  ["board_name:Bug Reports"],
  ["status:open", "status:tracked"],
  ["vote_highEngagement:true"],
]);
assert.deepEqual(filteredParams.params.numericFilters, [
  "score>=4",
  "post_created<=1700000000000",
]);

const luceneRequest = mapCannyToGateway(cannyBody, true);
assert.match(luceneRequest.url, /mode=lucene$/);
// Lucene mode carries constraints in the query string, not structured filters.
assert.equal(
  (luceneRequest.requestBody as Array<{ params: Record<string, unknown> }>)[0]
    .params.facetFilters,
  undefined,
);

const normalized = normalizeGatewayHit({
  objectID: "abc123",
  title: "Test",
  board: { urlName: "feature-requests", name: "Feature Requests" },
  _highlightResult: { title: { value: "Test" } },
});
assert.equal(normalized._id, "abc123");
assert.equal(normalized.objectID, undefined);
assert.deepEqual(normalized.tagIDs, []);
assert.equal(normalized.viewerVote, 0);
assert.equal(
  (normalized.voteSettings as { votesHidden?: boolean }).votesHidden,
  false,
);

const keptVote = normalizeGatewayHit({
  objectID: "voted1",
  viewerVote: 1,
  voteSettings: { votesHidden: false, highEngagement: true },
});
assert.equal(keptVote.viewerVote, 1);
assert.equal(
  (keptVote.voteSettings as { highEngagement?: boolean }).highEngagement,
  true,
);

const mappedVotes = normalizeGatewayHit(
  { objectID: "from-map", score: 4 },
  new Map([["from-map", 1]]),
);
assert.equal(mappedVotes.viewerVote, 1);
assert.equal(mappedVotes._id, "from-map");
assert.equal(mappedVotes.score, 5);

const privateScore = normalizeGatewayHit(
  { objectID: "local", score: 4 },
  undefined,
  { restoreScraperVote: false },
);
assert.equal(privateScore.score, 4);

const mapped = mapGatewayToCanny({
  results: [
    {
      hits: [normalized],
      page: 0,
      nbPages: 3,
      nbHits: 25,
      query: "avatar performance",
    },
  ],
});
assert.equal(mapped.result?.posts?.length, 1);
assert.equal(mapped.result?.hasNextPage, true);

const ssrData = {
  postQueries: {
    '{"currentBoard":"feature-requests","textSearch":"avatar","sort":"relevance"}': {
      result: { posts: [{ title: "Canny SSR hit" }] },
    },
    '{"currentBoard":"feature-requests","sort":"trendingScore"}': {
      result: { posts: [{ title: "Board list hit" }] },
    },
  },
};
assert.equal(stripSearchPostQueries(ssrData), 1);
assert.equal(Object.keys(ssrData.postQueries).length, 1);

// Roadmap preset queries (built by fetchPresetPosts) map to the expected
// facetFilters and sort indices.
const interestedPreset = mapCannyToGateway(
  {
    textSearch: "",
    pages: 1,
    filters: {
      refinements: { status: ["interested"] },
      ranges: {},
      toggles: {},
      sort: "",
    },
  },
  false,
);
const interestedParams = (interestedPreset.requestBody as Array<{
  indexName: string;
  params: Record<string, unknown>;
}>)[0];
assert.equal(interestedParams.indexName, "feedback-posts");
assert.deepEqual(interestedParams.params.facetFilters, [["status:interested"]]);

const engagementPreset = mapCannyToGateway(
  {
    textSearch: "",
    pages: 1,
    filters: {
      refinements: {},
      ranges: {},
      toggles: { vote_highEngagement: true },
      sort: "score_desc",
    },
  },
  false,
);
const engagementParams = (engagementPreset.requestBody as Array<{
  indexName: string;
  params: Record<string, unknown>;
}>)[0];
assert.equal(engagementParams.indexName, "feedback-posts_score_desc");
assert.deepEqual(engagementParams.params.facetFilters, [
  ["vote_highEngagement:true"],
]);

const pagedRequest = mapCannyToGateway(cannyBody, false, {
  hitsPerPage: 40,
  page: 0,
});
const pagedParams = (pagedRequest.requestBody as Array<{
  params: Record<string, unknown>;
}>)[0];
assert.equal(pagedParams.params.hitsPerPage, 40);
assert.equal(pagedParams.params.page, 0);

resetFilterState();
const defaultSearchMapped = mapCannyToGateway(
  {
    textSearch: "avatar",
    pages: 1,
    filters: {
      refinements: {},
      ranges: {},
      toggles: {},
      sort: getEffectiveSort("avatar"),
    },
  },
  false,
);
assert.equal(
  (defaultSearchMapped.requestBody as Array<{ indexName: string }>)[0]
    .indexName,
  `${INDEX_NAME}_relevance_desc`,
);
assert.equal(getEffectiveSort("avatar"), SEARCH_DEFAULT_SORT);

setSort("newest");
const explicitNewestMapped = mapCannyToGateway(
  {
    textSearch: "avatar",
    pages: 1,
    filters: {
      refinements: {},
      ranges: {},
      toggles: {},
      sort: getEffectiveSort("avatar"),
    },
  },
  false,
);
assert.equal(
  (explicitNewestMapped.requestBody as Array<{ indexName: string }>)[0]
    .indexName,
  INDEX_NAME,
);

resetFilterState();
const boardDefaultMapped = mapCannyToGateway(
  {
    textSearch: "",
    pages: 1,
    filters: {
      refinements: {},
      ranges: {},
      toggles: {},
      sort: getEffectiveSort(""),
    },
  },
  false,
);
assert.equal(
  (boardDefaultMapped.requestBody as Array<{ indexName: string }>)[0]
    .indexName,
  INDEX_NAME,
);
assert.equal(getEffectiveSort(""), DEFAULT_SORT);
resetFilterState();

console.info("mapping tests passed");
