import {
  buildCannySearchBody,
  buildPostQueryParams,
  readActiveSearchQuery,
  syncSearchInputValue,
  triggerSearchViaHistory,
} from "./canny-query";
import {
  applyCannySearchResults,
  findLiveSearchQueryParams,
  getCannyReduxStore,
  invalidateCannyPostQueries,
} from "./canny-store";
import { onRouteChange } from "./coverage";
import { needsListRefresh } from "./filter-state";
import { handleCannySearch } from "./search-handler";
import { stripSearchPostQueries } from "./ssr-hook";
import type { BridgeOptions } from "./types";

const BOOT_REFRESH_DELAYS_MS = [150, 500, 1200, 2500, 5000];

let refreshGeneration = 0;
let refreshInFlight = false;
let refreshPending = false;
let pendingForceHistory = false;

export { readActiveSearchQuery } from "./canny-query";

/**
 * True when the active text query went from non-empty to empty (sidebar and
 * list must drop search-scoped facets / results).
 */
export function isSearchQueryCleared(previous: string, next: string): boolean {
  return previous.trim().length > 0 && next.trim().length === 0;
}

export function installSearchQueryWatch(
  target: Window & typeof globalThis,
  onChange: (query: string, previous: string) => void,
): () => void {
  let last = readActiveSearchQuery(target);
  const check = (): void => {
    const query = readActiveSearchQuery(target);
    if (query === last) {
      return;
    }
    const previous = last;
    last = query;
    onChange(query, previous);
  };

  const onRoute = onRouteChange(target, check);
  target.document.addEventListener("input", check, true);
  target.document.addEventListener("change", check, true);
  return () => {
    onRoute();
    target.document.removeEventListener("input", check, true);
    target.document.removeEventListener("change", check, true);
  };
}

export function stripCachedSearchQueries(
  target: Window & typeof globalThis,
): void {
  const data = (target as Window & { __data?: Record<string, unknown> }).__data;
  if (data && typeof data === "object") {
    stripSearchPostQueries(data);
  }
}

/**
 * Push the current sidebar filters, sort, and Search-box query into Canny's
 * list. Overlapping calls coalesce: a refresh that arrives while one is in
 * flight is remembered and replayed once with the latest state, so rapid
 * filter + sort + search changes cannot drop the last combination.
 */
export async function runSearchRefresh(
  options: BridgeOptions,
  target: Window & typeof globalThis,
  refreshOptions: { forceHistory?: boolean } = {},
): Promise<boolean> {
  if (refreshInFlight) {
    refreshPending = true;
    if (refreshOptions.forceHistory) {
      pendingForceHistory = true;
    }
    return false;
  }

  refreshInFlight = true;
  let applied = false;
  try {
    do {
      refreshPending = false;
      const forceHistory = refreshOptions.forceHistory || pendingForceHistory;
      pendingForceHistory = false;
      const query = readActiveSearchQuery(target);

      stripCachedSearchQueries(target);
      if (query) {
        syncSearchInputValue(target, query);
      }

      const store = getCannyReduxStore(target);

      // With an active text query we can inject results directly into the post
      // query Canny keys by, avoiding a flash of native results.
      if (query && store) {
        const queryParams =
          findLiveSearchQueryParams(store, query) ??
          buildPostQueryParams(target, store);
        if (queryParams) {
          try {
            const cannyBody = buildCannySearchBody(target, queryParams);
            const cannyResponse = await handleCannySearch(
              options,
              cannyBody,
              target,
            );
            if (!cannyResponse.stale && !refreshPending) {
              applyCannySearchResults(store, queryParams, cannyResponse);
            }
            applied = true;
            continue;
          } catch (error) {
            console.warn("[vrcfb] direct search refresh failed", error);
          }
        }
      }

      // Board browsing / filter-only changes: force Canny to refetch the list,
      // which the network intercept serves from the gateway with the current
      // filter state applied.
      if (invalidateCannyPostQueries(target)) {
        applied = true;
        continue;
      }

      if (forceHistory || !store) {
        triggerSearchViaHistory(target, query);
        applied = true;
        continue;
      }

      applied = false;
    } while (refreshPending);
    return applied;
  } finally {
    refreshInFlight = false;
  }
}

export function scheduleSearchRefresh(
  options: BridgeOptions,
  target: Window & typeof globalThis,
  delayMs = 0,
  refreshOptions: { forceHistory?: boolean } = {},
): void {
  const generation = ++refreshGeneration;

  const run = (): void => {
    if (generation !== refreshGeneration) {
      return;
    }
    if (!readActiveSearchQuery(target) && !needsListRefresh()) {
      return;
    }
    void runSearchRefresh(options, target, refreshOptions);
  };

  if (delayMs <= 0) {
    run();
    return;
  }

  target.setTimeout(run, delayMs);
}

/**
 * Fetches the gateway once for the current view to populate the sidebar facet
 * counts without touching Canny's rendered list (Canny often serves the initial
 * board list from its SSR cache, so the network intercept may not fire on load).
 */
export async function primeFacets(
  options: BridgeOptions,
  target: Window & typeof globalThis,
  overrides: { textSearch?: string } = {},
): Promise<void> {
  const store = getCannyReduxStore(target);
  const queryParams = buildPostQueryParams(target, store) ?? { textSearch: "" };
  if (overrides.textSearch !== undefined) {
    queryParams.textSearch = overrides.textSearch;
  }
  try {
    const cannyBody = buildCannySearchBody(target, queryParams);
    await handleCannySearch(options, cannyBody, target);
  } catch (error) {
    console.warn("[vrcfb] facet prime failed", error);
  }
}

export function scheduleInitialSearchRefresh(
  options: BridgeOptions,
  target: Window & typeof globalThis,
): void {
  for (const delayMs of BOOT_REFRESH_DELAYS_MS) {
    scheduleSearchRefresh(options, target, delayMs);
  }
  scheduleSearchRefresh(
    options,
    target,
    BOOT_REFRESH_DELAYS_MS[BOOT_REFRESH_DELAYS_MS.length - 1],
    { forceHistory: true },
  );
}
