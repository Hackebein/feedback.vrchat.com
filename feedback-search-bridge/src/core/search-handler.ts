import { STORAGE_KEYS, cannyScoreFromIndex } from "./config";
import { getEffectiveSort, getFilterState } from "./filter-state";
import {
  buildViewerVoteMap,
  hydrateViewerVotes,
  viewerId,
} from "./viewer-votes";
import {
  mapCannyToGateway,
  mapGatewayToCanny,
  normalizeGatewayHit,
  readHitsPerPage,
  readPageIndex,
} from "./mapping";
import {
  facetsFromPosts,
  filterPrivatePosts,
  mergeFacetCounts,
  mergeSearchFacets,
  mergeSearchHits,
  paginateMergedHits,
  readSortKey,
} from "./private-search";
import { getAllPrivatePosts, type StoredPrivatePost } from "./private-store";
import type {
  BridgeOptions,
  BridgeSettings,
  BridgeStorage,
  CannySearchBody,
  CannySearchResponse,
  GatewaySearchResponse,
  SearchContext,
  SearchFacets,
  FacetStats,
} from "./types";

let settings: BridgeSettings = {
  luceneMode: false,
};

let settingsReady: Promise<void> | null = null;

export function setBridgeSettings(next: BridgeSettings): void {
  settings = { ...next };
}

export async function loadBridgeSettings(
  storage: BridgeStorage,
): Promise<BridgeSettings> {
  const luceneMode = await storage.get(STORAGE_KEYS.luceneMode, false);
  settings = { luceneMode };
  return settings;
}

async function ensureSettings(storage: BridgeStorage): Promise<BridgeSettings> {
  if (!settingsReady) {
    settingsReady = loadBridgeSettings(storage).then(() => undefined);
  }
  await settingsReady;
  return settings;
}

async function performGatewaySearch(
  transport: BridgeOptions["transport"],
  cannyBody: CannySearchBody,
  luceneMode: boolean,
  paging?: { hitsPerPage?: number; page?: number },
): Promise<GatewaySearchResponse> {
  const { url, requestBody } = mapCannyToGateway(cannyBody, luceneMode, paging);
  const response = await transport({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Gateway search failed (${response.status}): ${response.responseText.slice(0, 300)}`,
    );
  }

  try {
    return JSON.parse(response.responseText) as GatewaySearchResponse;
  } catch {
    throw new Error("Gateway search returned invalid JSON");
  }
}

export type PresetQuery = {
  refinements?: Record<string, string[]>;
  toggles?: Record<string, boolean>;
  sort?: string;
};

/**
 * Runs a one-off gateway query for a fixed set of filters/sort (used by the
 * home roadmap columns) and returns the raw hits. Reuses `mapCannyToGateway`
 * so facet/sort handling stays identical to the live search path.
 */
export async function fetchPresetPosts(
  options: BridgeOptions,
  preset: PresetQuery,
  limit = 10,
): Promise<Record<string, unknown>[]> {
  const body: CannySearchBody = {
    textSearch: "",
    pages: Math.max(1, Math.ceil(limit / 10)),
    filters: {
      refinements: preset.refinements ?? {},
      ranges: {},
      toggles: preset.toggles ?? {},
      sort: preset.sort ?? "",
    },
  };
  const gateway = await performGatewaySearch(options.transport, body, false);
  const hits = gateway.results?.[0]?.hits;
  return Array.isArray(hits) ? (hits as Record<string, unknown>[]) : [];
}

type SearchContextListener = (context: SearchContext) => void;

const searchContextListeners = new Set<SearchContextListener>();

export function onSearchContext(listener: SearchContextListener): () => void {
  searchContextListeners.add(listener);
  return () => {
    searchContextListeners.delete(listener);
  };
}

function dispatchSearchContext(context: SearchContext): void {
  for (const listener of searchContextListeners) {
    try {
      listener(context);
    } catch (error) {
      console.warn("[vrcfb] search context listener failed", error);
    }
  }
}

type FacetsListener = (facets: SearchFacets) => void;

const facetsListeners = new Set<FacetsListener>();

export function onFacets(listener: FacetsListener): () => void {
  facetsListeners.add(listener);
  return () => {
    facetsListeners.delete(listener);
  };
}

function dispatchFacets(facets: SearchFacets): void {
  for (const listener of facetsListeners) {
    try {
      listener(facets);
    } catch (error) {
      console.warn("[vrcfb] facets listener failed", error);
    }
  }
}

function restoreScoreStats(stats: FacetStats): FacetStats {
  const score = stats.score;
  if (!score) {
    return stats;
  }
  const next = { ...score };
  if (typeof next.min === "number" && Number.isFinite(next.min)) {
    next.min = cannyScoreFromIndex(next.min);
  }
  if (typeof next.max === "number" && Number.isFinite(next.max)) {
    next.max = cannyScoreFromIndex(next.max);
  }
  if (typeof next.avg === "number" && Number.isFinite(next.avg)) {
    next.avg = cannyScoreFromIndex(next.avg);
  }
  return { ...stats, score: next };
}

function extractFacets(gateway: GatewaySearchResponse): SearchFacets {
  const bucket = gateway.results?.[0];
  return {
    facets: bucket?.facets ?? {},
    stats: restoreScoreStats(bucket?.facets_stats ?? {}),
  };
}

/** Last unscoped `board_name` counts, held so the sidebar does not reshuffle
 * while a board-filtered search's disjunctive follow-up is in flight. */
let lastBoardNameFacet: Record<string, number> | undefined;

function rememberBoardNameFacet(facets: SearchFacets): void {
  const board = facets.facets.board_name;
  if (board) {
    lastBoardNameFacet = board;
  }
}

function needsDisjunctiveBoardFacet(
  body: CannySearchBody,
  luceneMode: boolean,
): boolean {
  const boards = body.filters?.refinements?.board_name;
  return !luceneMode && Array.isArray(boards) && boards.length > 0;
}

/** Paint previous (or omitted) board counts instead of the scoped collapse. */
function withHeldBoardName(facets: SearchFacets): SearchFacets {
  if (lastBoardNameFacet) {
    return {
      facets: { ...facets.facets, board_name: lastBoardNameFacet },
      stats: facets.stats,
    };
  }
  const { board_name: _ignored, ...rest } = facets.facets;
  return { facets: rest, stats: facets.stats };
}

/** Clone of the body with the board filter dropped (for disjunctive counts). */
function withoutBoardFilter(body: CannySearchBody): CannySearchBody {
  const filters = body.filters;
  if (!filters) {
    return body;
  }
  const refinements = { ...filters.refinements };
  delete refinements.board_name;
  return {
    ...body,
    pages: 1,
    filters: { ...filters, refinements },
  };
}

/**
 * The gateway scopes the `board_name` facet to the active board filter, so
 * selected-out boards report a count of 0. Re-run the query without the board
 * filter (other filters intact) to get true per-board counts so multi-select
 * stays meaningful.
 */
async function applyDisjunctiveBoardFacet(
  options: BridgeOptions,
  body: CannySearchBody,
  luceneMode: boolean,
  facets: SearchFacets,
): Promise<SearchFacets> {
  if (!needsDisjunctiveBoardFacet(body, luceneMode)) {
    return facets;
  }
  try {
    const disjoint = await performGatewaySearch(
      options.transport,
      withoutBoardFilter(body),
      luceneMode,
    );
    const boardFacet = extractFacets(disjoint).facets.board_name;
    if (boardFacet) {
      return {
        ...facets,
        facets: { ...facets.facets, board_name: boardFacet },
      };
    }
  } catch (error) {
    console.warn("[vrcfb] disjunctive board facet failed", error);
  }
  return facets;
}

let searchEpoch = 0;

function emptyGateway(): GatewaySearchResponse {
  return { results: [{ hits: [], facets: {}, page: 0, nbPages: 0, nbHits: 0 }] };
}

async function loadLocalPosts(
  body: CannySearchBody,
  luceneMode: boolean,
  target?: Window & typeof globalThis,
): Promise<{
  matches: StoredPrivatePost[];
  boardMatches: StoredPrivatePost[];
}> {
  if (!target) {
    return { matches: [], boardMatches: [] };
  }
  const id = viewerId(target);
  const all = await getAllPrivatePosts(id, target);
  if (all.length === 0) {
    return { matches: [], boardMatches: [] };
  }
  const matches = filterPrivatePosts(all, body, { luceneMode });
  const boardMatches = luceneMode
    ? matches
    : filterPrivatePosts(all, body, { luceneMode, ignoreBoard: true });
  return { matches, boardMatches };
}

export async function handleCannySearch(
  options: BridgeOptions,
  cannyBody: CannySearchBody,
  target?: Window & typeof globalThis,
): Promise<CannySearchResponse> {
  const epoch = ++searchEpoch;
  const current = await ensureSettings(options.storage);
  const textSearch =
    typeof cannyBody.textSearch === "string" ? cannyBody.textSearch : "";
  const body: CannySearchBody = {
    ...cannyBody,
    filters: { ...getFilterState(), sort: getEffectiveSort(textSearch) },
  };
  const local = await loadLocalPosts(body, current.luceneMode, target);
  const pageSize = readHitsPerPage(body);
  const page = readPageIndex(body);
  const paging =
    local.matches.length > 0
      ? {
          page: 0,
          hitsPerPage: Math.min(500, Math.max(pageSize, (page + 1) * pageSize)),
        }
      : undefined;

  let gatewayResponse: GatewaySearchResponse;
  try {
    gatewayResponse = await performGatewaySearch(
      options.transport,
      body,
      current.luceneMode,
      paging,
    );
  } catch (error) {
    if (local.matches.length === 0) {
      throw error;
    }
    console.warn("[vrcfb] gateway search failed; using private-board index", error);
    gatewayResponse = emptyGateway();
  }

  const gatewayHits = Array.isArray(gatewayResponse.results?.[0]?.hits)
    ? (gatewayResponse.results[0].hits as Record<string, unknown>[])
    : [];
  const voteSource = [
    ...gatewayHits,
    ...local.matches.map((post) => post.payload),
  ];
  if (target) {
    await hydrateViewerVotes(options.storage, target);
  }
  const viewerVotes = target
    ? buildViewerVoteMap(target, voteSource)
    : new Map<string, number>();

  let cannyResponse: CannySearchResponse;
  if (local.matches.length === 0) {
    cannyResponse = mapGatewayToCanny(gatewayResponse, viewerVotes);
  } else {
    const normalizedGateway = gatewayHits.map((hit) =>
      normalizeGatewayHit(
        hit && typeof hit === "object" && !Array.isArray(hit) ? hit : {},
        viewerVotes,
      ),
    );
    const normalizedLocal = local.matches.map((post) => ({
      ...post,
      payload: normalizeGatewayHit(post.payload, viewerVotes, {
        restoreScraperVote: false,
      }),
    }));
    const merged = mergeSearchHits(
      normalizedGateway,
      normalizedLocal,
      readSortKey(body),
      typeof body.textSearch === "string" ? body.textSearch : "",
    );
    const paged = paginateMergedHits(merged, page, pageSize);
    cannyResponse = {
      result: {
        posts: paged.posts,
        hasNextPage: paged.hasNextPage,
      },
    };
  }

  // A newer list/facet request (e.g. the user cleared search) owns the sidebar
  // and the visible list. Mark stale so intercepts abort instead of painting
  // this payload, and so a direct Redux inject is skipped.
  if (epoch !== searchEpoch) {
    return { ...cannyResponse, stale: true };
  }

  const context: SearchContext = {
    cannyBody: body,
    gatewayResponse,
    cannyResponse,
  };
  dispatchSearchContext(context);

  const gatewayFacets = extractFacets(gatewayResponse);
  const localFacets = facetsFromPosts(local.matches);
  const localBoardFacets = facetsFromPosts(local.boardMatches);
  const baseFacets = mergeSearchFacets(gatewayFacets, localFacets);
  if (localBoardFacets.facets.board_name) {
    baseFacets.facets = {
      ...baseFacets.facets,
      board_name:
        mergeFacetCounts(
          { board_name: gatewayFacets.facets.board_name ?? {} },
          { board_name: localBoardFacets.facets.board_name },
        ).board_name ?? {},
    };
  }
  const holdBoardName = needsDisjunctiveBoardFacet(body, current.luceneMode);
  if (holdBoardName) {
    dispatchFacets(withHeldBoardName(baseFacets));
  } else {
    dispatchFacets(baseFacets);
    rememberBoardNameFacet(baseFacets);
  }
  void applyDisjunctiveBoardFacet(
    options,
    body,
    current.luceneMode,
    gatewayFacets,
  ).then((refined) => {
    if (epoch !== searchEpoch) {
      return;
    }
    const localBoard = localBoardFacets.facets.board_name;
    if (!localBoard && refined === gatewayFacets) {
      return;
    }
    const board = mergeFacetCounts(
      { board_name: refined.facets.board_name ?? {} },
      { board_name: localBoard ?? {} },
    ).board_name;
    const next: SearchFacets = {
      facets: {
        ...baseFacets.facets,
        ...(board ? { board_name: board } : {}),
      },
      stats: baseFacets.stats,
    };
    rememberBoardNameFacet(next);
    dispatchFacets(next);
  });

  return cannyResponse;
}

export function createMemoryStorage(
  initial: Partial<BridgeSettings> = {},
): BridgeStorage {
  const map = new Map<string, unknown>([
    [STORAGE_KEYS.luceneMode, initial.luceneMode ?? false],
  ]);
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      return map.has(key) ? (map.get(key) as T) : fallback;
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
  };
}
