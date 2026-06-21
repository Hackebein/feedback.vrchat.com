/**
 * Holds the most recent main-query InstantSearch params (query + facetFilters +
 * numericFilters) so notification subscriptions can replay the exact filter the
 * user is viewing. Kept in its own module to avoid an App <-> Notifications
 * import cycle.
 */
let lastSearchParams: Record<string, unknown> | null = null;

export function setCurrentSearchParams(params: Record<string, unknown>): void {
  lastSearchParams = { ...params };
}

export function getCurrentSearchParams(): Record<string, unknown> {
  return lastSearchParams ? { ...lastSearchParams } : {};
}
