import assert from "node:assert/strict";
import {
  buildPostQueryParams,
  cannyListSortKey,
  CANNY_SEARCH_SORT,
  readActiveSearchQuery,
  syncSearchInputValue,
} from "../src/core/canny-query";
import {
  applyCannySearchResults,
  findLiveSearchQueryParams,
} from "../src/core/canny-store";
import {
  DEFAULT_SORT,
  getEffectiveSort,
  needsListRefresh,
  resetFilterState,
  SEARCH_DEFAULT_SORT,
  setSort,
} from "../src/core/filter-state";
import { isSearchQueryCleared } from "../src/core/search-refresh";

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
  input?: string,
): Window & typeof globalThis {
  const inputEl = input === undefined ? null : { value: input };
  return {
    location: { href },
    document: {
      querySelector: () => inputEl,
    },
  } as unknown as Window & typeof globalThis;
}

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
  resetFilterState();
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

assert.equal(isSearchQueryCleared("avatar", ""), true);
assert.equal(isSearchQueryCleared("avatar", "  "), true);
assert.equal(isSearchQueryCleared("avatar", "avatars"), false);
assert.equal(isSearchQueryCleared("", ""), false);
assert.equal(isSearchQueryCleared("", "avatar"), false);

assert.equal(
  readActiveSearchQuery(
    mockTarget("https://feedback.vrchat.com/?search=foo", "bar"),
  ),
  "bar",
);
assert.equal(
  readActiveSearchQuery(
    mockTarget("https://feedback.vrchat.com/?search=foo", ""),
  ),
  "",
);
assert.equal(
  isSearchQueryCleared(
    "foo",
    readActiveSearchQuery(
      mockTarget("https://feedback.vrchat.com/?search=foo", ""),
    ),
  ),
  true,
);
assert.equal(
  readActiveSearchQuery(mockTarget("https://feedback.vrchat.com/?search=foo")),
  "foo",
);

const syncInput = { value: "bar" };
const syncTarget = {
  location: { href: "https://feedback.vrchat.com/?search=foo" },
  document: { querySelector: () => syncInput },
} as unknown as Window & typeof globalThis;
syncSearchInputValue(syncTarget, "foo");
assert.equal(syncInput.value, "bar");

resetFilterState();
assert.equal(getEffectiveSort(""), DEFAULT_SORT);
assert.equal(getEffectiveSort("avatar"), SEARCH_DEFAULT_SORT);
setSort("newest");
assert.equal(getEffectiveSort("avatar"), "newest");
resetFilterState();
assert.equal(needsListRefresh(), false);
setSort("score_desc");
assert.equal(needsListRefresh(), true);
resetFilterState();

const emptyActions: unknown[] = [];
applyCannySearchResults(
  {
    dispatch: (action: unknown) => {
      emptyActions.push(action);
    },
    getState: () => ({}),
  },
  { textSearch: "avatar", sort: "relevance" },
  { result: { posts: [], hasNextPage: false } },
);
assert.equal(emptyActions.length, 1);
const emptyLoaded = emptyActions[0] as {
  type: string;
  result: { posts: unknown[] };
};
assert.equal(emptyLoaded.type, "canny/post_queries/query_loaded");
assert.deepEqual(emptyLoaded.result.posts, []);

console.info("canny-query tests passed");
