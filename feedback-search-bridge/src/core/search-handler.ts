import { STORAGE_KEYS, cannyScoreFromIndex } from "./config";
import { REFINEMENT_ATTRS, getEffectiveSort, getFilterState } from "./filter-state";
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
  additionalFacetCounts,
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
  FacetCounts,
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

type GatewayQuery = {
  indexName: string;
  params: Record<string, unknown>;
};

function gatewayQueries(body: unknown): GatewayQuery[] {
  if (!Array.isArray(body)) {
    return [];
  }
  return body.filter((entry): entry is GatewayQuery => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const query = entry as GatewayQuery;
    return typeof query.indexName === "string" && !!query.params && typeof query.params === "object";
  });
}

async function postGateway(
  transport: BridgeOptions["transport"],
  url: string,
  requestBody: unknown,
): Promise<GatewaySearchResponse> {
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

async function performGatewaySearch(
  transport: BridgeOptions["transport"],
  cannyBody: CannySearchBody,
  luceneMode: boolean,
  paging?: { hitsPerPage?: number; page?: number },
): Promise<GatewaySearchResponse> {
  const { url, requestBody } = mapCannyToGateway(cannyBody, luceneMode, paging);
  return postGateway(transport, url, requestBody);
}

function selectedEnumFacets(
  body: CannySearchBody,
): { attribute: string; values: string[] }[] {
  const refinements = body.filters?.refinements;
  if (!refinements) {
    return [];
  }
  const selected: { attribute: string; values: string[] }[] = [];
  for (const attribute of REFINEMENT_ATTRS) {
    const values = refinements[attribute];
    if (Array.isArray(values) && values.length > 0) {
      selected.push({ attribute, values });
    }
  }
  return selected;
}

/**
 * Main query plus one hits-free query per checked enum facet. Each extra query
 * drops that facet's filter and sets `excludeFacet` so the gateway counts
 * posts that value would add.
 */
async function performEnumSearch(
  transport: BridgeOptions["transport"],
  body: CannySearchBody,
  luceneMode: boolean,
  paging?: { hitsPerPage?: number; page?: number },
): Promise<GatewaySearchResponse> {
  const main = mapCannyToGateway(body, luceneMode, paging);
  const queries = gatewayQueries(main.requestBody);
  if (!luceneMode) {
    for (const facet of selectedEnumFacets(body)) {
      const filters = body.filters;
      const refinements = { ...filters?.refinements };
      delete refinements[facet.attribute];
      const extra = mapCannyToGateway(
        filters ? { ...body, filters: { ...filters, refinements } } : body,
        false,
        { hitsPerPage: 0, page: 0 },
      );
      for (const query of gatewayQueries(extra.requestBody)) {
        query.params.excludeFacet = facet;
        query.params.hitsPerPage = 0;
        query.params.page = 0;
        queries.push(query);
      }
    }
  }
  return postGateway(transport, main.url, queries);
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

/** Additional-hit buckets from the last completed search. */
let lastAdditional: FacetCounts = {};
/** In-result facet counts from the last completed search. */
let lastShownFacets: FacetCounts = {};

function gatewayAdditional(
  response: GatewaySearchResponse,
  selected: { attribute: string }[],
): { counts: FacetCounts; seen: Set<string> } {
  const counts: FacetCounts = {};
  const seen = new Set<string>();
  selected.forEach((facet, index) => {
    const result = response.results?.[index + 1];
    if (!result) {
      return;
    }
    seen.add(facet.attribute);
    counts[facet.attribute] = result.facets?.[facet.attribute] ?? {};
  });
  return { counts, seen };
}

function combineAdditional(
  selected: { attribute: string }[],
  gatewayCounts: FacetCounts,
  seen: Set<string>,
  localCounts: FacetCounts,
): FacetCounts {
  const held: FacetCounts = {};
  for (const facet of selected) {
    const attr = facet.attribute;
    if (seen.has(attr)) {
      held[attr] = gatewayCounts[attr] ?? {};
    } else if (lastAdditional[attr]) {
      held[attr] = lastAdditional[attr];
    } else if (lastShownFacets[attr]) {
      held[attr] = lastShownFacets[attr];
    }
  }
  const merged = mergeFacetCounts(held, localCounts);
  const out: FacetCounts = {};
  for (const facet of selected) {
    out[facet.attribute] = merged[facet.attribute] ?? held[facet.attribute] ?? {};
  }
  return out;
}

let searchEpoch = 0;

function emptyGateway(): GatewaySearchResponse {
  return { results: [{ hits: [], facets: {}, page: 0, nbPages: 0, nbHits: 0 }] };
}

async function loadLocalPosts(
  target?: Window & typeof globalThis,
): Promise<StoredPrivatePost[]> {
  if (!target) {
    return [];
  }
  return getAllPrivatePosts(viewerId(target), target);
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
  const allLocal = await loadLocalPosts(target);
  const matches = filterPrivatePosts(allLocal, body, { luceneMode: current.luceneMode });
  const pageSize = readHitsPerPage(body);
  const page = readPageIndex(body);
  const paging =
    matches.length > 0
      ? {
          page: 0,
          hitsPerPage: Math.min(500, Math.max(pageSize, (page + 1) * pageSize)),
        }
      : undefined;

  let gatewayResponse: GatewaySearchResponse;
  try {
    gatewayResponse = await performEnumSearch(
      options.transport,
      body,
      current.luceneMode,
      paging,
    );
  } catch (error) {
    if (matches.length === 0) {
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
    ...matches.map((post) => post.payload),
  ];
  if (target) {
    await hydrateViewerVotes(options.storage, target);
  }
  const viewerVotes = target
    ? buildViewerVoteMap(target, voteSource)
    : new Map<string, number>();

  let cannyResponse: CannySearchResponse;
  if (matches.length === 0) {
    cannyResponse = mapGatewayToCanny(gatewayResponse, viewerVotes);
  } else {
    const normalizedGateway = gatewayHits.map((hit) =>
      normalizeGatewayHit(
        hit && typeof hit === "object" && !Array.isArray(hit) ? hit : {},
        viewerVotes,
      ),
    );
    const normalizedLocal = matches.map((post) => ({
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
  // and Redux inject. Still return this payload so Canny's in-flight intercept
  // completes with 200 instead of aborting into "posts couldn't be loaded".
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
  const baseFacets = mergeSearchFacets(gatewayFacets, facetsFromPosts(matches));
  const selected = current.luceneMode ? [] : selectedEnumFacets(body);
  const fromGateway = gatewayAdditional(gatewayResponse, selected);
  const additional =
    selected.length === 0
      ? {}
      : combineAdditional(
          selected,
          fromGateway.counts,
          fromGateway.seen,
          additionalFacetCounts(allLocal, body, current.luceneMode),
        );
  const nextFacets: SearchFacets = {
    facets: baseFacets.facets,
    additional,
    stats: baseFacets.stats,
  };
  lastShownFacets = nextFacets.facets;
  lastAdditional = additional;
  dispatchFacets(nextFacets);

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
