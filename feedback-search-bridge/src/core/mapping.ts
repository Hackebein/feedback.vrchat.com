import {
  GATEWAY_ORIGIN,
  INDEX_NAME,
  SEARCH_API_PATH,
  cannyScoreFromIndex,
  indexScoreFromCanny,
} from "./config";
import { applyViewerVoteState } from "./viewer-votes";
import {
  RANGE_ATTRS,
  REFINEMENT_ATTRS,
  REQUESTED_FACETS,
  TOGGLE_ATTRS,
} from "./filter-state";
import type {
  CannySearchBody,
  CannySearchResponse,
  GatewaySearchResponse,
} from "./types";

const SORT_TO_INDEX: Record<string, string> = {
  newest: INDEX_NAME,
  oldest: `${INDEX_NAME}_created_asc`,
  trendingScore: `${INDEX_NAME}_activity_desc`,
  trending: `${INDEX_NAME}_activity_desc`,
  activity_desc: `${INDEX_NAME}_activity_desc`,
  activity_asc: `${INDEX_NAME}_activity_asc`,
  statusChanged_desc: `${INDEX_NAME}_statusChanged_desc`,
  statusChanged_asc: `${INDEX_NAME}_statusChanged_asc`,
  created_asc: `${INDEX_NAME}_created_asc`,
  score: `${INDEX_NAME}_score_desc`,
  top: `${INDEX_NAME}_score_desc`,
  score_desc: `${INDEX_NAME}_score_desc`,
  score_asc: `${INDEX_NAME}_score_asc`,
  relevance: `${INDEX_NAME}_relevance_desc`,
  relevance_desc: `${INDEX_NAME}_relevance_desc`,
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Gateway index for this list request. `filters.sort` is the effective sidebar
 * sort: untouched Newest becomes relevance while a text query is active
 * (`getEffectiveSort` in handleCannySearch). An explicit dropdown choice wins.
 */
function readSortIndex(body: CannySearchBody): string {
  const sort = readString(body.filters?.sort) || readString(body.sort);
  const hasSearch = readString(body.textSearch).length > 0;
  if (!sort) {
    return hasSearch
      ? `${INDEX_NAME}_relevance_desc`
      : INDEX_NAME;
  }
  return SORT_TO_INDEX[sort] ?? (hasSearch ? `${INDEX_NAME}_relevance_desc` : INDEX_NAME);
}

export function readHitsPerPage(body: CannySearchBody): number {
  const pages =
    typeof body.pages === "number" && Number.isFinite(body.pages)
      ? Math.trunc(body.pages)
      : 1;
  return Math.min(Math.max(pages, 1) * 10, 500);
}

export function readPageIndex(body: CannySearchBody): number {
  const raw = body.page;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function buildFacetFilters(body: CannySearchBody): string[][] {
  const filters: string[][] = [];
  const selection = body.filters;

  // Board (and every other) scope comes only from the sidebar facets. The URL
  // board / status are intentionally ignored so switching the create-form board
  // does not limit the post list.
  if (selection) {
    for (const attr of REFINEMENT_ATTRS) {
      const values = selection.refinements[attr];
      if (Array.isArray(values) && values.length > 0) {
        filters.push(values.map((value) => `${attr}:${value}`));
      }
    }
    for (const attr of TOGGLE_ATTRS) {
      if (selection.toggles[attr] === true) {
        filters.push([`${attr}:true`]);
      }
    }
  }

  return filters;
}

function buildNumericFilters(body: CannySearchBody): string[] {
  const selection = body.filters;
  if (!selection) {
    return [];
  }
  const filters: string[] = [];
  for (const attr of RANGE_ATTRS) {
    const range = selection.ranges[attr];
    if (!range) {
      continue;
    }
    if (typeof range.min === "number" && Number.isFinite(range.min)) {
      const min = attr === "score" ? indexScoreFromCanny(range.min) : range.min;
      filters.push(`${attr}>=${min}`);
    }
    if (typeof range.max === "number" && Number.isFinite(range.max)) {
      const max = attr === "score" ? indexScoreFromCanny(range.max) : range.max;
      filters.push(`${attr}<=${max}`);
    }
  }
  return filters;
}

export function mapCannyToGateway(
  body: CannySearchBody,
  luceneMode: boolean,
  paging?: { hitsPerPage?: number; page?: number },
): { url: string; requestBody: unknown } {
  const query = readString(body.textSearch);
  const params: Record<string, unknown> = {
    query,
    hitsPerPage: paging?.hitsPerPage ?? readHitsPerPage(body),
    page: paging?.page ?? readPageIndex(body),
    facets: REQUESTED_FACETS,
    maxValuesPerFacet: 200,
  };

  // Lucene mode carries all constraints inside the query string; the facet
  // sidebar is hidden, so structured filters are not applied.
  if (!luceneMode) {
    const facetFilters = buildFacetFilters(body);
    if (facetFilters.length > 0) {
      params.facetFilters = facetFilters;
    }
    const numericFilters = buildNumericFilters(body);
    if (numericFilters.length > 0) {
      params.numericFilters = numericFilters;
    }
  }

  const url = luceneMode
    ? `${GATEWAY_ORIGIN}${SEARCH_API_PATH}?mode=lucene`
    : `${GATEWAY_ORIGIN}${SEARCH_API_PATH}`;

  return {
    url,
    requestBody: [
      {
        indexName: readSortIndex(body),
        params,
      },
    ],
  };
}

function defaultCannyFields(): Record<string, unknown> {
  return {
    tagIDs: [],
    deleted: false,
    spam: false,
    etaPublic: true,
    boardCommentsArePrivate: false,
    boardDeleted: false,
    customPostFields: [],
    totalMRR: 0,
    totalOpportunityValue: 0,
    totalOpenOpportunityValue: 0,
    viewerVote: 0,
  };
}

function restoreScraperVoteCount(post: Record<string, unknown>): void {
  if (typeof post.score === "number" && Number.isFinite(post.score)) {
    post.score = cannyScoreFromIndex(post.score);
  }
}

function ensureVoteSettings(post: Record<string, unknown>): void {
  const settings = post.voteSettings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    post.voteSettings = { votesHidden: false };
    return;
  }
  const record = settings as Record<string, unknown>;
  if (typeof record.votesHidden !== "boolean") {
    record.votesHidden = false;
  }
}

export function normalizeGatewayHit(
  hit: Record<string, unknown>,
  viewerVotes?: Map<string, number>,
  options?: { restoreScraperVote?: boolean },
): Record<string, unknown> {
  // Defaults first so Canny list payloads (private-board index) keep their own
  // `viewerVote` / `etaPublic` instead of being reset to stubs.
  const post: Record<string, unknown> = { ...defaultCannyFields(), ...hit };

  const id =
    readString(hit.objectID) ||
    readString(hit.post_id) ||
    readString(hit._id);
  if (id) {
    post._id = id;
  }
  applyViewerVoteState(post, viewerVotes);
  if (options?.restoreScraperVote !== false) {
    restoreScraperVoteCount(post);
  }
  ensureVoteSettings(post);

  delete post.objectID;
  delete post._index;
  delete post._score;
  delete post._highlightResult;
  delete post._snippetResult;
  delete post.post_id;

  return post;
}

export function mapGatewayToCanny(
  gateway: GatewaySearchResponse,
  viewerVotes?: Map<string, number>,
): CannySearchResponse {
  const bucket = gateway.results?.[0];
  if (!bucket) {
    return { result: { posts: [], hasNextPage: false } };
  }

  const hits = Array.isArray(bucket.hits) ? bucket.hits : [];
  const posts = hits.map((hit) =>
    normalizeGatewayHit(
      hit && typeof hit === "object" && !Array.isArray(hit)
        ? (hit as Record<string, unknown>)
        : {},
      viewerVotes,
    ),
  );

  const page = typeof bucket.page === "number" ? bucket.page : 0;
  const nbPages =
    typeof bucket.nbPages === "number" ? bucket.nbPages : posts.length > 0 ? 1 : 0;

  return {
    result: {
      posts,
      hasNextPage: page + 1 < nbPages,
    },
  };
}

/**
 * Distinguishes Canny's post-list requests (board browsing / search) from
 * single-post fetches that also hit `/api/posts/get`. We only take over list
 * requests; intercepting a single-post fetch would replace the detail payload
 * with a list and break post pages.
 */
function isListRequestBody(body: CannySearchBody): boolean {
  // Single-post fetches identify a specific post and carry no list controls.
  const singlePostKeys = ["id", "postID", "urlName", "postURLName", "byID"];
  const hasSinglePostKey = singlePostKeys.some(
    (key) => typeof body[key] === "string" && (body[key] as string).length > 0,
  );

  const hasBoardList = Array.isArray(body.boardURLNames);
  const hasTextSearch = readString(body.textSearch).length > 0;
  const hasListControl =
    hasBoardList ||
    hasTextSearch ||
    typeof body.sort === "string" ||
    typeof body.pages === "number" ||
    typeof body.limit === "number" ||
    typeof body.skip === "number" ||
    typeof body.currentBoard === "string";

  if (!hasListControl) {
    return false;
  }

  // A board-scoped list may legitimately include currentBoard; reject only when
  // a single-post identifier is present without any board-list marker.
  if (hasSinglePostKey && !hasBoardList && !hasTextSearch) {
    return false;
  }

  return true;
}

export function isCannySearchRequest(
  url: string,
  method: string,
  bodyText: string | undefined,
): CannySearchBody | null {
  if (method.toUpperCase() !== "POST") {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, "https://feedback.vrchat.com");
  } catch {
    return null;
  }

  if (!parsedUrl.pathname.endsWith("/api/posts/get")) {
    return null;
  }

  if (!bodyText) {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const cannyBody = body as CannySearchBody;
  if (!isListRequestBody(cannyBody)) {
    return null;
  }

  return cannyBody;
}
