import assert from "node:assert/strict";
import {
  buildPostQueryParams,
  cannyListSortKey,
  CANNY_SEARCH_SORT,
} from "../src/core/canny-query";
import { findLiveSearchQueryParams } from "../src/core/canny-store";
import { DEFAULT_SORT, setSort } from "../src/core/filter-state";

assert.equal(cannyListSortKey("avatar", "score_desc"), CANNY_SEARCH_SORT);
assert.equal(cannyListSortKey("avatar", "newest"), CANNY_SEARCH_SORT);
assert.equal(cannyListSortKey("avatar", "relevance_desc"), CANNY_SEARCH_SORT);
assert.equal(cannyListSortKey("  avatar  ", "activity_desc"), CANNY_SEARCH_SORT);
assert.equal(cannyListSortKey("", "score_desc"), "score_desc");
assert.equal(cannyListSortKey("", "", "trendingScore"), "trendingScore");
assert.equal(cannyListSortKey("", "newest", "trendingScore"), "newest");
assert.equal(cannyListSortKey("", "", ""), "");

function mockTarget(
  href: string,
  searchInput = "",
): Window & typeof globalThis {
  const input = searchInput ? { value: searchInput } : null;
  return {
    location: { href },
    document: {
      querySelector: () => input,
    },
  } as unknown as Window & typeof globalThis;
}

const previousSort = DEFAULT_SORT;
try {
  setSort("score_desc");
  const searchParams = buildPostQueryParams(
    mockTarget("https://feedback.vrchat.com/feature-requests?search=avatar"),
    null,
  );
  assert.equal(searchParams?.sort, CANNY_SEARCH_SORT);
  assert.equal(searchParams?.textSearch, "avatar");

  setSort("newest");
  const searchNewest = buildPostQueryParams(
    mockTarget("https://feedback.vrchat.com/feature-requests?search=avatar"),
    null,
  );
  assert.equal(searchNewest?.sort, CANNY_SEARCH_SORT);

  setSort("relevance_desc");
  const searchRelevance = buildPostQueryParams(
    mockTarget("https://feedback.vrchat.com/feature-requests?search=avatar"),
    null,
  );
  assert.equal(searchRelevance?.sort, CANNY_SEARCH_SORT);

  setSort("score_desc");
  const boardOnly = buildPostQueryParams(
    mockTarget("https://feedback.vrchat.com/feature-requests"),
    null,
  );
  assert.equal(boardOnly?.sort, "score_desc");
  assert.equal(boardOnly?.textSearch, "");
} finally {
  setSort(previousSort);
}

const liveKey = {
  currentBoard: "feature-requests",
  textSearch: "avatar",
  sort: "relevance",
};
const rebuiltKey = {
  currentBoard: { urlName: "feature-requests" },
  textSearch: "avatar",
  sort: "score_desc",
};

const flatStore = {
  dispatch: () => undefined,
  getState: () => ({
    postQueries: {
      [JSON.stringify(liveKey)]: { result: { posts: [] } },
      '{"currentBoard":"feature-requests","sort":"trendingScore"}': {
        result: { posts: [] },
      },
    },
  }),
};
assert.deepEqual(findLiveSearchQueryParams(flatStore, "avatar"), liveKey);
assert.equal(findLiveSearchQueryParams(flatStore, "missing"), null);
assert.equal(findLiveSearchQueryParams(flatStore, ""), null);
assert.equal(findLiveSearchQueryParams(null, "avatar"), null);

const itemsStore = {
  dispatch: () => undefined,
  getState: () => ({
    postQueries: {
      loading: false,
      items: {
        [JSON.stringify(liveKey)]: { result: { posts: [] } },
        [JSON.stringify(rebuiltKey)]: { result: { posts: [] } },
      },
    },
  }),
};
assert.deepEqual(findLiveSearchQueryParams(itemsStore, "avatar"), liveKey);

const otherSortStore = {
  dispatch: () => undefined,
  getState: () => ({
    postQueries: {
      [JSON.stringify(rebuiltKey)]: { result: { posts: [] } },
    },
  }),
};
assert.deepEqual(findLiveSearchQueryParams(otherSortStore, "avatar"), rebuiltKey);

console.info("canny-query tests passed");
