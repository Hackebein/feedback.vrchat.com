import type { FilterState, RangeValue } from "./types";

/**
 * Facet attribute identifiers must match the gateway searchkit `facet_attributes`
 * (search-ui/server/searchkit-config.ts).
 */
export const REFINEMENT_ATTRS = [
  "board_name",
  "status",
  "category_name",
  "aiCategories",
  "author_name",
  "voter_name",
  "comment_author_name",
] as const;

export const RANGE_ATTRS = [
  "score",
  "maxScore",
  "commentCount",
  "mergeCount",
  "trendingScore",
  "comment_likeCount",
  "post_created",
  "post_updated",
  "post_statusChanged",
  "comment_created",
] as const;

export const TOGGLE_ATTRS = [
  "vote_highEngagement",
  "vote_moderateEngagement",
  "vote_lowEngagement",
  "comment_pinned",
] as const;

export const DATE_ATTRS: ReadonlySet<string> = new Set([
  "post_created",
  "post_updated",
  "post_statusChanged",
  "comment_created",
]);

export const REQUESTED_FACETS: string[] = [
  ...REFINEMENT_ATTRS,
  ...RANGE_ATTRS,
  ...TOGGLE_ATTRS,
];

export const DEFAULT_SORT = "newest";

/** Sort index used for text search until the user picks a different order. */
export const SEARCH_DEFAULT_SORT = "relevance_desc";

function emptyState(): FilterState {
  return { refinements: {}, ranges: {}, toggles: {}, sort: DEFAULT_SORT };
}

let state: FilterState = emptyState();
/** True after the user picks a sort in the dropdown (including Newest). */
let sortChosenByUser = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[vrcfb] filter-state listener failed", error);
    }
  }
}

export function onFilterStateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFilterState(): FilterState {
  return state;
}

export function hasActiveFilters(value: FilterState = state): boolean {
  if (Object.values(value.refinements).some((list) => list.length > 0)) {
    return true;
  }
  if (
    Object.values(value.ranges).some(
      (range) => range.min !== undefined || range.max !== undefined,
    )
  ) {
    return true;
  }
  if (Object.values(value.toggles).some(Boolean)) {
    return true;
  }
  return false;
}

/** True when facets, ranges, toggles, or a non-default sort should refresh the list. */
export function needsListRefresh(value: FilterState = state): boolean {
  return hasActiveFilters(value) || value.sort !== DEFAULT_SORT;
}

/**
 * Sort sent to the gateway. A text query with the untouched default (Newest)
 * uses relevance; an explicit dropdown choice — including Newest — is honored.
 */
export function getEffectiveSort(textSearch = ""): string {
  if (textSearch.trim() && !sortChosenByUser) {
    return SEARCH_DEFAULT_SORT;
  }
  return state.sort;
}

export function getRefinementValues(attr: string): string[] {
  return state.refinements[attr] ?? [];
}

export function isRefined(attr: string, value: string): boolean {
  return (state.refinements[attr] ?? []).includes(value);
}

export function toggleRefinement(attr: string, value: string): void {
  const current = state.refinements[attr] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  const refinements = { ...state.refinements };
  if (next.length > 0) {
    refinements[attr] = next;
  } else {
    delete refinements[attr];
  }
  state = { ...state, refinements };
  emit();
}

export function getRange(attr: string): RangeValue {
  return state.ranges[attr] ?? {};
}

export function setRange(attr: string, range: RangeValue): void {
  const ranges = { ...state.ranges };
  const min = Number.isFinite(range.min) ? range.min : undefined;
  const max = Number.isFinite(range.max) ? range.max : undefined;
  if (min === undefined && max === undefined) {
    delete ranges[attr];
  } else {
    ranges[attr] = { min, max };
  }
  state = { ...state, ranges };
  emit();
}

export function getToggle(attr: string): boolean {
  return state.toggles[attr] === true;
}

export function setToggle(attr: string, on: boolean): void {
  const toggles = { ...state.toggles };
  if (on) {
    toggles[attr] = true;
  } else {
    delete toggles[attr];
  }
  state = { ...state, toggles };
  emit();
}

export function getSort(): string {
  return state.sort;
}

export function setSort(sort: string): void {
  sortChosenByUser = true;
  state = { ...state, sort };
  emit();
}

export function clearAllFilters(): void {
  const sort = state.sort;
  state = { ...emptyState(), sort };
  emit();
}

/** Test helper: restore default filters and the untouched-sort flag. */
export function resetFilterState(): void {
  state = emptyState();
  sortChosenByUser = false;
  emit();
}
