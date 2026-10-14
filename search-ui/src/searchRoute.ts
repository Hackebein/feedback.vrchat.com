export const FEEDBACK_INDEX = "feedback-posts";

export type RouteAttr = { urlKey: string; attr: string };

/** Facet URL keys, in the order the website writes them. Parsing walks this list, not the query-string order. */
export const REFINEMENT_LIST_ATTRS: readonly RouteAttr[] = [
  { urlKey: "board.name", attr: "board_name" },
  { urlKey: "status", attr: "status" },
  { urlKey: "category.name", attr: "category_name" },
  { urlKey: "aiCategories", attr: "aiCategories" },
  { urlKey: "author.name", attr: "author_name" },
  { urlKey: "voters.name", attr: "voter_name" },
  { urlKey: "comments.author.name", attr: "comment_author_name" },
];

export const RANGE_ATTRS: readonly RouteAttr[] = [
  { urlKey: "score", attr: "score" },
  { urlKey: "maxScore", attr: "maxScore" },
  { urlKey: "commentCount", attr: "commentCount" },
  { urlKey: "mergeCount", attr: "mergeCount" },
  { urlKey: "trendingScore", attr: "trendingScore" },
  { urlKey: "comments.likeCount", attr: "comment_likeCount" },
  { urlKey: "created", attr: "post_created" },
  { urlKey: "updatedAt", attr: "post_updated" },
  { urlKey: "statusChanged", attr: "post_statusChanged" },
  { urlKey: "comments.created", attr: "comment_created" },
];

export const TOGGLE_ATTRS: readonly RouteAttr[] = [
  { urlKey: "voteSettings.highEngagement", attr: "vote_highEngagement" },
  { urlKey: "voteSettings.moderateEngagement", attr: "vote_moderateEngagement" },
  { urlKey: "voteSettings.lowEngagement", attr: "vote_lowEngagement" },
  { urlKey: "comments.pinned", attr: "comment_pinned" },
];

/** Refinement lists from a parsed URL. Attribute order follows `attrs`; value order inside one facet is kept. */
export function refinementListsFromRoute(
  route: Record<string, unknown>,
  attrs: readonly RouteAttr[],
): Record<string, string[]> {
  const lists: Record<string, string[]> = {};
  for (const { urlKey, attr } of attrs) {
    const raw = route[urlKey];
    if (Array.isArray(raw)) {
      const list = raw.map(String).filter(Boolean);
      if (list.length > 0) lists[attr] = list;
    } else if (typeof raw === "string" && raw) {
      lists[attr] = [raw];
    }
  }
  return lists;
}

export function rangesFromRoute(
  route: Record<string, unknown>,
  attrs: readonly RouteAttr[],
): Record<string, string> {
  const ranges: Record<string, string> = {};
  for (const { urlKey, attr } of attrs) {
    const raw = route[urlKey];
    if (typeof raw === "string" && raw) ranges[attr] = raw;
  }
  return ranges;
}

export function togglesFromRoute(
  route: Record<string, unknown>,
  attrs: readonly RouteAttr[],
): Record<string, boolean> {
  const toggles: Record<string, boolean> = {};
  for (const { urlKey, attr } of attrs) {
    const raw = route[urlKey];
    if (raw === "1" || raw === "true" || raw === true) toggles[attr] = true;
  }
  return toggles;
}

const RELEVANCE_INDEX = `${FEEDBACK_INDEX}_relevance_desc`;

export const SORT_INDEX_TO_PARAM: Record<string, string> = {
  [`${FEEDBACK_INDEX}_created_asc`]: "created_asc",
  [`${FEEDBACK_INDEX}_activity_desc`]: "activity_desc",
  [`${FEEDBACK_INDEX}_activity_asc`]: "activity_asc",
  [`${FEEDBACK_INDEX}_score_desc`]: "score_desc",
  [`${FEEDBACK_INDEX}_score_asc`]: "score_asc",
  [RELEVANCE_INDEX]: "relevance_desc",
};

const SORT_PARAM_TO_INDEX: Record<string, string> = Object.fromEntries(
  Object.entries(SORT_INDEX_TO_PARAM).map(([index, param]) => [param, index]),
);

/**
 * URL sort for the current InstantSearch state.
 * Relevance is the default whenever a text query is present, so it stays off
 * the URL. Newest is omitted while browsing and written as `newest` once a
 * query is active, otherwise a refresh would snap back to relevance.
 */
export function sortByToRouteParam(
  sortBy: string | undefined,
  hasQuery: boolean,
): string | undefined {
  if (!sortBy || sortBy === RELEVANCE_INDEX) {
    return undefined;
  }
  if (sortBy === FEEDBACK_INDEX) {
    return hasQuery ? "newest" : undefined;
  }
  return SORT_INDEX_TO_PARAM[sortBy];
}

/** Index `sortBy` for a URL. A text query with no sort param ranks by relevance. */
export function routeParamToSortBy(
  sort: string | undefined,
  hasQuery: boolean,
): string | undefined {
  if (sort === "newest") {
    return FEEDBACK_INDEX;
  }
  if (sort) {
    const mapped = SORT_PARAM_TO_INDEX[sort];
    if (mapped) {
      return mapped;
    }
  }
  if (hasQuery) {
    return RELEVANCE_INDEX;
  }
  return undefined;
}
