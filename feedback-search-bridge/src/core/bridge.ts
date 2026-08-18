import { installNetworkIntercept } from "./intercept";
import { installListAugment } from "./list-augment";
import { applyLuceneMode, installFilterSidebar } from "./filter-sidebar";
import {
  consumeBoardPreselectSuppression,
  installCreateBoardSelect,
} from "./create-board-select";
import { installRoadmap } from "./roadmap";
import { installAttribution } from "./attribution";
import {
  applyActiveClass,
  currentSlug,
  isLocationCovered,
  loadCoverage,
  onCoverageChange,
  onRouteChange,
} from "./coverage";
import { isRefined, toggleRefinement } from "./filter-state";
import { mountBridgeControl } from "./control";
import {
  loadBridgeSettings,
  setBridgeSettings,
} from "./search-handler";
import { installIndexWatch } from "./index-watch";
import { startPrivateIndex } from "./private-index";
import {
  installSearchQueryWatch,
  isSearchQueryCleared,
  primeFacets,
  readActiveSearchQuery,
  scheduleInitialSearchRefresh,
  scheduleSearchRefresh,
  runSearchRefresh,
} from "./search-refresh";
import type { BridgeOptions, BridgeSettings } from "./types";

/** Display name for the board whose `urlName` matches `slug`, or "". */
function boardNameForSlug(
  target: Window & typeof globalThis,
  slug: string,
): string {
  const items = (target as unknown as {
    __data?: { boards?: { items?: Record<string, { urlName?: string; name?: string }> } };
  }).__data?.boards?.items;
  if (!items) {
    return "";
  }
  for (const board of Object.values(items)) {
    if (board?.urlName === slug && typeof board.name === "string" && board.name.trim()) {
      return board.name.trim();
    }
  }
  return "";
}

/**
 * The board we last auto-selected from the URL. Tracked so that navigating
 * between boards swaps this one out for the new board instead of leaving the
 * previous board stuck selected — while any boards the user picked manually in
 * the sidebar are left untouched (multi-select stays intact).
 */
let autoBoardName = "";

/**
 * Keep the filter sidebar's board facet in sync with the current board URL: on
 * a covered board page, select that board (swapping out the previously
 * URL-selected board). The home page leaves the selection alone. Returns true
 * if the selection changed so the caller can refresh the list.
 */
function preselectCurrentBoard(target: Window & typeof globalThis): boolean {
  if (!isLocationCovered(target)) {
    return false;
  }
  const slug = currentSlug(target);
  // The home page is not board-scoped; don't touch the user's board selection.
  if (!slug) {
    return false;
  }
  const targetName = boardNameForSlug(target, slug);
  if (!targetName || targetName === autoBoardName) {
    return false;
  }
  let changed = false;
  // Drop the board we previously auto-selected from the URL (but not manual picks).
  if (autoBoardName && isRefined("board_name", autoBoardName)) {
    toggleRefinement("board_name", autoBoardName);
    changed = true;
  }
  if (!isRefined("board_name", targetName)) {
    toggleRefinement("board_name", targetName);
    changed = true;
  }
  autoBoardName = targetName;
  return changed;
}

export function installBridge(
  options: BridgeOptions,
  target: Window & typeof globalThis = window,
): void {
  installNetworkIntercept(options, target);
  installListAugment(target);

  // Coverage gating: mark the page active for covered boards / home, refresh on
  // route changes, and disable the bridge on boards we do not index.
  applyActiveClass(target);
  onRouteChange(target, () => applyActiveClass(target));
  onCoverageChange(() => applyActiveClass(target));
  void loadCoverage(options).then(() => {
    startPrivateIndex(target, () => {
      void runSearchRefresh(options, target);
    });
  });

  const triggerRefresh = (): void => {
    void runSearchRefresh(options, target);
    scheduleSearchRefresh(options, target, 250);
  };

  // Preselect the board facet when arriving at a board via SPA navigation too
  // (the empty-guard inside keeps it from clobbering an existing selection).
  onRouteChange(target, () => {
    if (consumeBoardPreselectSuppression()) {
      return;
    }
    if (preselectCurrentBoard(target)) {
      triggerRefresh();
    }
  });

  installSearchQueryWatch(target, (query, previous) => {
    if (!isSearchQueryCleared(previous, query)) {
      return;
    }
    // Clearing search often restores Canny's cached board list with no new
    // /api/posts/get, so intercept never refreshes sidebar facet counts.
    void primeFacets(options, target, { textSearch: "" });
    triggerRefresh();
  });

  installFilterSidebar(target, triggerRefresh, () => {
    void primeFacets(options, target);
  });
  installCreateBoardSelect(target);
  installRoadmap(options, target);
  installAttribution(target);
  installIndexWatch(options, target, () => runSearchRefresh(options, target));

  const bootUi = () => {
    void loadBridgeSettings(options.storage).then((current) => {
      applyLuceneMode(target, current.luceneMode);
      mountBridgeControl(options.storage, current, target, (next) => {
        setBridgeSettings(next);
        document.dispatchEvent(
          new CustomEvent("vrcfb-settings-changed", {
            detail: { ...next },
          }),
        );
      }, triggerRefresh);

      const preselected = preselectCurrentBoard(target);
      if (readActiveSearchQuery(target)) {
        scheduleInitialSearchRefresh(options, target);
      } else if (preselected) {
        // Re-run the list so the preselected board scopes the initial results.
        triggerRefresh();
      } else if (!current.luceneMode) {
        void primeFacets(options, target);
      }
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootUi, { once: true });
  } else {
    bootUi();
  }

  document.addEventListener("vrcfb-settings-changed", ((event: CustomEvent<BridgeSettings>) => {
    setBridgeSettings(event.detail);
    applyLuceneMode(target, event.detail.luceneMode);
    // Entering filter (non-Lucene) mode with no active search still needs facet
    // counts, so prime them when the sidebar becomes visible.
    if (!event.detail.luceneMode && !readActiveSearchQuery(target)) {
      void primeFacets(options, target);
    }
  }) as EventListener);
}

export { createMemoryStorage } from "./search-handler";
