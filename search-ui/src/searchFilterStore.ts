import { NO_AUTHOR_VALUE, POST_AUTHOR_FACET, POST_AUTHOR_NAME_PREFIX } from "../../shared/post-author-facet";

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
let filterKey = "{}";
const listeners = new Set<() => void>();

const namedAuthorFilter = `${POST_AUTHOR_FACET}:${POST_AUTHOR_NAME_PREFIX}`;
const missingAuthorFilter = `${POST_AUTHOR_FACET}:${NO_AUTHOR_VALUE}`;

function replayFacetFilters(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const legacyName = (filter: unknown) =>
    typeof filter === "string" && filter.startsWith(namedAuthorFilter)
      ? `author_name:${filter.slice(namedAuthorFilter.length)}`
      : filter;

  // Keep named-only filters identical to those in existing subscriptions.
  return value.map((filter) => {
    if (!Array.isArray(filter)) return legacyName(filter);
    return filter.includes(missingAuthorFilter) ? filter : filter.map(legacyName);
  });
}

export function setCurrentSearchParams(params: Record<string, unknown>): void {
  const normalized: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) {
      normalized[key] = key === "facetFilters" ? replayFacetFilters(value) : value;
    }
  }
  lastSearchParams = normalized;
  const nextKey = JSON.stringify(normalized);
  if (nextKey !== filterKey) {
    filterKey = nextKey;
    for (const listener of listeners) listener();
  }
}

export function subscribeCurrentSearchParams(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCurrentSearchFilterKey(): string { return filterKey; }

export function getCurrentSearchParams(): Record<string, unknown> {
  return lastSearchParams ? { ...lastSearchParams } : {};
}
