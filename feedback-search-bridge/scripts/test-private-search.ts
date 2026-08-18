import assert from "node:assert/strict";
import {
  buildCombinedText,
  facetsFromPosts,
  filterPrivatePosts,
  mergeFacetCounts,
  mergeSearchHits,
  paginateMergedHits,
  queryTokens,
  relevanceScore,
  toStoredPost,
} from "../src/core/private-search";
import type { StoredPrivatePost } from "../src/core/private-store";
import type { CannySearchBody } from "../src/core/types";

function stored(
  partial: Record<string, unknown>,
  boardSlug = "internal",
): StoredPrivatePost {
  const payload = {
    _id: "p1",
    urlName: "post",
    title: "Hello world",
    details: "Avatar performance",
    status: "open",
    score: 10,
    commentCount: 0,
    created: "2024-01-02T00:00:00.000Z",
    board: { name: "Internal Roadmap Posts", urlName: boardSlug },
    author: { name: "Alex" },
    voteSettings: { highEngagement: false, lowEngagement: true, moderateEngagement: false },
    ...partial,
  };
  return toStoredPost(payload, boardSlug);
}

assert.deepEqual(queryTokens("  Avatar   Crash "), ["avatar", "crash"]);
assert.equal(relevanceScore("avatar avatar crash", ["avatar"]), 2);

const internal = stored({
  _id: "a",
  title: "Udon UI",
  details: "Quick menu buttons",
  created: "2024-06-01T00:00:00.000Z",
  score: 3,
  comments: [{ value: "in backlog", author: { name: "Fax" } }],
});
const sellers = stored(
  {
    _id: "b",
    title: "Payout delay",
    details: "Store cashout",
    created: "2024-07-01T00:00:00.000Z",
    score: 20,
    status: "tracked",
    board: { name: "Avatar Marketplace Sellers", urlName: "avatar-marketplace-sellers" },
  },
  "avatar-marketplace-sellers",
);
const older = stored({
  _id: "c",
  title: "Old idea",
  details: "Something else",
  created: "2023-01-01T00:00:00.000Z",
  score: 5,
});

assert.match(buildCombinedText(internal.payload), /in backlog/);

const textBody: CannySearchBody = {
  textSearch: "udon backlog",
  filters: { refinements: {}, ranges: {}, toggles: {}, sort: "newest" },
};
const textHits = filterPrivatePosts([internal, sellers, older], textBody, {
  luceneMode: false,
});
assert.deepEqual(
  textHits.map((post) => post._id),
  ["a"],
);

const boardBody: CannySearchBody = {
  textSearch: "",
  filters: {
    refinements: { board_name: ["Avatar Marketplace Sellers"] },
    ranges: {},
    toggles: {},
    sort: "newest",
  },
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], boardBody, { luceneMode: false }).map(
    (post) => post._id,
  ),
  ["b"],
);
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], boardBody, {
    luceneMode: false,
    ignoreBoard: true,
  }).map((post) => post._id).sort(),
  ["a", "b", "c"],
);

const rangeBody: CannySearchBody = {
  textSearch: "",
  filters: {
    refinements: {},
    ranges: { score: { min: 10 } },
    toggles: {},
    sort: "score_desc",
  },
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], rangeBody, { luceneMode: false }).map(
    (post) => post._id,
  ),
  ["b"],
);

const luceneBody: CannySearchBody = {
  textSearch: "payout",
  filters: boardBody.filters,
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], luceneBody, { luceneMode: true }).map(
    (post) => post._id,
  ),
  ["b"],
);

const gatewayHits = [
  {
    _id: "g1",
    title: "Public",
    created: "2024-05-01T00:00:00.000Z",
    score: 1,
  },
];
const mergedNewest = mergeSearchHits(
  gatewayHits,
  [internal, sellers, older],
  "newest",
  "",
);
assert.deepEqual(
  mergedNewest.map((hit) => hit._id),
  ["b", "a", "g1", "c"],
);

const page0 = paginateMergedHits(mergedNewest, 0, 2);
assert.deepEqual(
  page0.posts.map((hit) => hit._id),
  ["b", "a"],
);
assert.equal(page0.hasNextPage, true);
const page1 = paginateMergedHits(mergedNewest, 1, 2);
assert.deepEqual(
  page1.posts.map((hit) => hit._id),
  ["g1", "c"],
);
assert.equal(page1.hasNextPage, false);

const scoreMerged = mergeSearchHits(gatewayHits, [internal, sellers], "score_desc", "");
assert.equal(scoreMerged[0]?._id, "b");

const localFacets = facetsFromPosts([internal, sellers]);
assert.equal(localFacets.facets.board_name?.["Internal Roadmap Posts"], 1);
assert.equal(localFacets.facets.status?.open, 1);
assert.equal(localFacets.stats.score?.max, 20);

assert.deepEqual(
  mergeFacetCounts(
    { board_name: { "Feature Requests": 10 } },
    { board_name: { "Internal Roadmap Posts": 2, "Feature Requests": 1 } },
  ).board_name,
  { "Feature Requests": 11, "Internal Roadmap Posts": 2 },
);

console.info("private-search tests passed");
