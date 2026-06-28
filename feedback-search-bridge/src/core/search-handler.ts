import { STORAGE_KEYS } from "./config";
import { getFilterState } from "./filter-state";
import { buildViewerVoteMap } from "./viewer-votes";
import { mapCannyToGateway, mapGatewayToCanny } from "./mapping";
import type {
  BridgeOptions,
  BridgeSettings,
  BridgeStorage,
  CannySearchBody,
  CannySearchResponse,
  GatewaySearchResponse,
  SearchContext,
  SearchFacets,
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
): Promise<GatewaySearchResponse> {
  const { url, requestBody } = mapCannyToGateway(cannyBody, luceneMode);
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

function extractFacets(gateway: GatewaySearchResponse): SearchFacets {
  const bucket = gateway.results?.[0];
  return {
    facets: bucket?.facets ?? {},
    stats: bucket?.facets_stats ?? {},
  };
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
  const boards = body.filters?.refinements?.board_name;
  if (luceneMode || !Array.isArray(boards) || boards.length === 0) {
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

export async function handleCannySearch(
  options: BridgeOptions,
  cannyBody: CannySearchBody,
  target?: Window & typeof globalThis,
): Promise<CannySearchResponse> {
  const current = await ensureSettings(options.storage);
  const body: CannySearchBody = { ...cannyBody, filters: getFilterState() };
  const gatewayResponse = await performGatewaySearch(
    options.transport,
    body,
    current.luceneMode,
  );
  const viewerVotes = target
    ? buildViewerVoteMap(target, gatewayResponse.results?.[0]?.hits)
    : new Map<string, number>();
  const cannyResponse = mapGatewayToCanny(gatewayResponse, viewerVotes);
  const context: SearchContext = {
    cannyBody: body,
    gatewayResponse,
    cannyResponse,
  };
  dispatchSearchContext(context);

  // Dispatch the scoped facets right away so the list isn't blocked, then refine
  // the board counts disjunctively in the background when boards are selected.
  const baseFacets = extractFacets(gatewayResponse);
  dispatchFacets(baseFacets);
  void applyDisjunctiveBoardFacet(options, body, current.luceneMode, baseFacets).then(
    (refined) => {
      if (refined !== baseFacets) {
        dispatchFacets(refined);
      }
    },
  );

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
