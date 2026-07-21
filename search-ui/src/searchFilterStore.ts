/**
 * Holds the most recent main-query InstantSearch filter so notification
 * subscriptions can replay the exact filter the user is viewing. Kept in its
 * own module to avoid an App <-> Notifications import cycle.
 *
 * Only the filter-defining params are retained. Presentation params (page,
 * hitsPerPage, facets, highlighting, ...) are stripped so the stored filter is
 * stable as the user paginates. This keeps the notification upsert key
 * (filter JSON) constant across page changes, so toggling a subscription
 * updates the same row instead of creating duplicates.
 */
const FILTER_KEYS = [
  "query",
  "facetFilters",
  "numericFilters",
  "filters",
  "tagFilters",
] as const;

let lastSearchParams: Record<string, unknown> | null = null;

export function setCurrentSearchParams(params: Record<string, unknown>): void {
  const normalized: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      normalized[key] = value;
    }
  }
  lastSearchParams = normalized;
}

export function getCurrentSearchParams(): Record<string, unknown> {
  return lastSearchParams ? { ...lastSearchParams } : {};
}
