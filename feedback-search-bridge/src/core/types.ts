export type BridgeTransportRequest = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

export type BridgeTransportResponse = {
  status: number;
  statusText: string;
  responseText: string;
  headers: Record<string, string>;
};

export type BridgeTransport = (
  request: BridgeTransportRequest,
) => Promise<BridgeTransportResponse>;

export type BridgeStorage = {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
};

export type BridgeOptions = {
  transport: BridgeTransport;
  storage: BridgeStorage;
};

export type RangeValue = { min?: number; max?: number };

export type FilterState = {
  refinements: Record<string, string[]>;
  ranges: Record<string, RangeValue>;
  toggles: Record<string, boolean>;
  sort: string;
};

export type CannySearchBody = {
  textSearch?: string;
  boardURLNames?: string[] | string;
  currentBoard?: string;
  pages?: number;
  status?: string;
  sort?: string;
  filters?: FilterState;
  [key: string]: unknown;
};

export type CannySearchResponse = {
  result?: {
    posts?: Record<string, unknown>[];
    hasNextPage?: boolean;
  };
  error?: string;
  /** True when a newer search superseded this one; do not paint the list. */
  stale?: boolean;
};

export type FacetCounts = Record<string, Record<string, number>>;

export type FacetStat = { min?: number; max?: number; avg?: number; sum?: number };

export type FacetStats = Record<string, FacetStat>;

export type GatewaySearchResult = {
  hits?: Record<string, unknown>[];
  page?: number;
  nbPages?: number;
  nbHits?: number;
  hitsPerPage?: number;
  query?: string;
  facets?: FacetCounts;
  facets_stats?: FacetStats;
};

export type GatewaySearchResponse = {
  results?: GatewaySearchResult[];
};

export type SearchFacets = {
  facets: FacetCounts;
  stats: FacetStats;
};

export type BridgeSettings = {
  luceneMode: boolean;
};

export type SearchContext = {
  cannyBody: CannySearchBody;
  gatewayResponse: GatewaySearchResponse;
  cannyResponse: CannySearchResponse;
};
