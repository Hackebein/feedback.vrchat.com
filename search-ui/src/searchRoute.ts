export const FEEDBACK_INDEX = "feedback-posts";

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
