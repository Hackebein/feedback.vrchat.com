import {
  RANGE_ATTRS,
  REFINEMENT_ATTRS,
  TOGGLE_ATTRS,
} from "./filter-state";
import type {
  CannySearchBody,
  FacetCounts,
  FacetStats,
  FilterState,
  SearchFacets,
} from "./types";
import type { StoredPrivatePost } from "./private-store";

export type LocalSearchOptions = {
  luceneMode: boolean;
  ignoreBoard?: boolean;
};

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function toEpoch(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) {
      return ms;
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function commentSnippets(comment: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["value", "statusChangeNewStatus", "mergedPostTitle", "mergedPostDetails"]) {
    const text = readString(comment[key]);
    if (text) {
      out.push(text);
    }
  }
  const author = nestedRecord(comment.author);
  const authorName = author ? readString(author.name) : "";
  if (authorName) {
    out.push(authorName);
  }
  return out;
}

function payloadComments(payload: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(payload.comments)
    ? payload.comments.filter(
        (entry): entry is Record<string, unknown> =>
          !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export function buildCombinedText(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  const title = readString(payload.title);
  const details = readString(payload.details);
  if (title) {
    parts.push(title);
  }
  if (details) {
    parts.push(details);
  }
  const author = nestedRecord(payload.author);
  const authorName = author ? readString(author.name) : "";
  if (authorName) {
    parts.push(authorName);
  }
  for (const comment of payloadComments(payload)) {
    parts.push(...commentSnippets(comment));
  }
  return parts.join("\n");
}

export function computeLastActivityAt(payload: Record<string, unknown>): number {
  const candidates: number[] = [];
  for (const key of ["created", "statusChanged", "updatedAt"]) {
    const ms = toEpoch(payload[key]);
    if (ms !== undefined) {
      candidates.push(ms);
    }
  }
  for (const comment of payloadComments(payload)) {
    if (comment.deleted === true || comment.spam === true) {
      continue;
    }
    const ms = toEpoch(comment.created);
    if (ms !== undefined) {
      candidates.push(ms);
    }
  }
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

export function toStoredPost(
  payload: Record<string, unknown>,
  boardSlug: string,
  prev?: StoredPrivatePost,
): StoredPrivatePost {
  const id = readString(payload._id);
  const urlName = readString(payload.urlName) || prev?.urlName || "";
  const commentCount =
    typeof payload.commentCount === "number" && Number.isFinite(payload.commentCount)
      ? payload.commentCount
      : prev?.listedCommentCount ?? 0;
  const lastActivityAt = computeLastActivityAt(payload);
  const withActivity =
    payload.lastActivityAt == null && lastActivityAt > 0
      ? { ...payload, lastActivityAt: new Date(lastActivityAt).toISOString() }
      : payload;
  return {
    _id: id,
    boardSlug,
    urlName,
    listedAt: Date.now(),
    detailedAt: prev?.detailedAt,
    listedCommentCount: commentCount,
    combinedText: buildCombinedText(withActivity),
    lastActivityAt,
    payload: withActivity,
  };
}

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function matchesQuery(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const hay = text.toLowerCase();
  return tokens.every((token) => hay.includes(token));
}

export function relevanceScore(text: string, tokens: string[]): number {
  if (tokens.length === 0) {
    return 0;
  }
  const hay = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    let from = 0;
    while (from < hay.length) {
      const at = hay.indexOf(token, from);
      if (at < 0) {
        break;
      }
      score += 1;
      from = at + token.length;
    }
  }
  return score;
}

function refinementValues(
  payload: Record<string, unknown>,
  attr: string,
): string[] {
  switch (attr) {
    case "board_name": {
      const name = readString(nestedRecord(payload.board)?.name);
      return name ? [name] : [];
    }
    case "status": {
      const status = readString(payload.status);
      return status ? [status] : [];
    }
    case "category_name": {
      const name = readString(nestedRecord(payload.category)?.name);
      return name ? [name] : [];
    }
    case "aiCategories": {
      const cats = payload.aiCategories;
      if (!Array.isArray(cats)) {
        return [];
      }
      return cats
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter(Boolean);
    }
    case "author_name": {
      const name = readString(nestedRecord(payload.author)?.name);
      return name ? [name] : [];
    }
    case "voter_name": {
      const voters = payload.voters;
      if (!Array.isArray(voters)) {
        return [];
      }
      const names: string[] = [];
      for (const entry of voters) {
        const name = readString(nestedRecord(entry)?.name);
        if (name) {
          names.push(name);
        }
      }
      return names;
    }
    case "comment_author_name": {
      const names: string[] = [];
      for (const comment of payloadComments(payload)) {
        const name = readString(nestedRecord(comment.author)?.name);
        if (name) {
          names.push(name);
        }
      }
      return names;
    }
    default:
      return [];
  }
}

function numericValues(
  post: StoredPrivatePost,
  attr: string,
): number[] {
  const payload = post.payload;
  switch (attr) {
    case "score":
    case "maxScore":
    case "commentCount":
    case "mergeCount":
    case "trendingScore": {
      const value = payload[attr];
      return typeof value === "number" && Number.isFinite(value) ? [value] : [];
    }
    case "post_created": {
      const ms = toEpoch(payload.created);
      return ms !== undefined ? [ms] : [];
    }
    case "post_updated": {
      const ms = toEpoch(payload.updatedAt);
      return ms !== undefined ? [ms] : [];
    }
    case "post_statusChanged": {
      const ms = toEpoch(payload.statusChanged);
      return ms !== undefined ? [ms] : [];
    }
    case "comment_likeCount": {
      const values: number[] = [];
      for (const comment of payloadComments(payload)) {
        const likes = comment.likeCount;
        if (typeof likes === "number" && Number.isFinite(likes)) {
          values.push(likes);
        }
      }
      return values;
    }
    case "comment_created": {
      const values: number[] = [];
      for (const comment of payloadComments(payload)) {
        const ms = toEpoch(comment.created);
        if (ms !== undefined) {
          values.push(ms);
        }
      }
      return values;
    }
    default:
      return [];
  }
}

function toggleMatches(payload: Record<string, unknown>, attr: string): boolean {
  if (attr === "comment_pinned") {
    return payloadComments(payload).some((comment) => comment.pinned === true);
  }
  const settings = nestedRecord(payload.voteSettings);
  if (!settings) {
    return false;
  }
  if (attr === "vote_highEngagement") {
    return settings.highEngagement === true;
  }
  if (attr === "vote_moderateEngagement") {
    return settings.moderateEngagement === true;
  }
  if (attr === "vote_lowEngagement") {
    return settings.lowEngagement === true;
  }
  return false;
}

function matchesFilters(
  post: StoredPrivatePost,
  filters: FilterState | undefined,
  ignoreBoard: boolean,
): boolean {
  if (!filters) {
    return true;
  }
  for (const attr of REFINEMENT_ATTRS) {
    if (ignoreBoard && attr === "board_name") {
      continue;
    }
    const selected = filters.refinements[attr];
    if (!Array.isArray(selected) || selected.length === 0) {
      continue;
    }
    const values = refinementValues(post.payload, attr);
    if (!selected.some((value) => values.includes(value))) {
      return false;
    }
  }
  for (const attr of TOGGLE_ATTRS) {
    if (filters.toggles[attr] === true && !toggleMatches(post.payload, attr)) {
      return false;
    }
  }
  for (const attr of RANGE_ATTRS) {
    const range = filters.ranges[attr];
    if (!range) {
      continue;
    }
    const values = numericValues(post, attr);
    if (values.length === 0) {
      return false;
    }
    const inRange = values.some((value) => {
      if (typeof range.min === "number" && Number.isFinite(range.min) && value < range.min) {
        return false;
      }
      if (typeof range.max === "number" && Number.isFinite(range.max) && value > range.max) {
        return false;
      }
      return true;
    });
    if (!inRange) {
      return false;
    }
  }
  return true;
}

export function filterPrivatePosts(
  posts: StoredPrivatePost[],
  body: CannySearchBody,
  options: LocalSearchOptions,
): StoredPrivatePost[] {
  const tokens = queryTokens(readString(body.textSearch));
  const filters = options.luceneMode ? undefined : body.filters;
  const ignoreBoard = options.ignoreBoard === true;
  return posts.filter((post) => {
    if (!matchesQuery(post.combinedText, tokens)) {
      return false;
    }
    return matchesFilters(post, filters, ignoreBoard);
  });
}

function sortKey(
  post: Record<string, unknown>,
  sort: string,
  tokens: string[],
  combinedText: string,
): number {
  switch (sort) {
    case "oldest":
    case "created_asc":
    case "newest":
      return toEpoch(post.created) ?? 0;
    case "score":
    case "top":
    case "score_desc":
    case "score_asc":
      return typeof post.score === "number" && Number.isFinite(post.score)
        ? post.score
        : 0;
    case "trendingScore":
    case "trending":
    case "activity_desc":
    case "activity_asc":
      return toEpoch(post.lastActivityAt) ?? 0;
    case "statusChanged_desc":
    case "statusChanged_asc":
      return toEpoch(post.statusChanged) ?? 0;
    case "relevance":
    case "relevance_desc":
      return relevanceScore(combinedText, tokens);
    default:
      return toEpoch(post.created) ?? 0;
  }
}

function sortAscending(sort: string, hasQuery: boolean): boolean {
  if (sort === "oldest" || sort === "created_asc" || sort === "score_asc" || sort === "activity_asc" || sort === "statusChanged_asc") {
    return true;
  }
  if (!sort && !hasQuery) {
    return false;
  }
  return false;
}

export function sortHits(
  hits: Record<string, unknown>[],
  sort: string,
  query: string,
  combinedTextOf?: (hit: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const tokens = queryTokens(query);
  const hasQuery = tokens.length > 0;
  const resolved = sort.trim() || (hasQuery ? "relevance" : "newest");
  const asc = sortAscending(resolved, hasQuery);
  const decorated = hits.map((hit, index) => ({
    hit,
    index,
    key: sortKey(
      hit,
      resolved,
      tokens,
      combinedTextOf ? combinedTextOf(hit) : buildCombinedText(hit),
    ),
  }));
  decorated.sort((a, b) => {
    const diff = a.key - b.key;
    if (diff !== 0) {
      return asc ? diff : -diff;
    }
    return a.index - b.index;
  });
  return decorated.map((entry) => entry.hit);
}

export function mergeSearchHits(
  gatewayHits: Record<string, unknown>[],
  localPosts: StoredPrivatePost[],
  sort: string,
  query: string,
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const textById = new Map<string, string>();
  for (const hit of gatewayHits) {
    const id = readString(hit._id);
    if (!id) {
      continue;
    }
    byId.set(id, hit);
    textById.set(id, buildCombinedText(hit));
  }
  for (const post of localPosts) {
    if (!post._id) {
      continue;
    }
    byId.set(post._id, post.payload);
    textById.set(post._id, post.combinedText);
  }
  return sortHits([...byId.values()], sort, query, (hit) => {
    const id = readString(hit._id);
    return (id && textById.get(id)) || buildCombinedText(hit);
  });
}

export function paginateMergedHits(
  merged: Record<string, unknown>[],
  page: number,
  pageSize: number,
): { posts: Record<string, unknown>[]; hasNextPage: boolean } {
  const size = Math.max(1, pageSize);
  const offset = Math.max(0, page) * size;
  return {
    posts: merged.slice(offset, offset + size),
    hasNextPage: merged.length > offset + size,
  };
}

export function facetsFromPosts(posts: StoredPrivatePost[]): SearchFacets {
  const facets: FacetCounts = {};
  const stats: FacetStats = {};
  const bump = (attr: string, value: string): void => {
    if (!value) {
      return;
    }
    const bucket = facets[attr] ?? (facets[attr] = {});
    bucket[value] = (bucket[value] ?? 0) + 1;
  };
  const noteStat = (attr: string, value: number): void => {
    const prev = stats[attr];
    if (!prev) {
      stats[attr] = { min: value, max: value };
      return;
    }
    if (typeof prev.min !== "number" || value < prev.min) {
      prev.min = value;
    }
    if (typeof prev.max !== "number" || value > prev.max) {
      prev.max = value;
    }
  };

  for (const post of posts) {
    for (const attr of REFINEMENT_ATTRS) {
      for (const value of refinementValues(post.payload, attr)) {
        bump(attr, value);
      }
    }
    for (const attr of TOGGLE_ATTRS) {
      if (toggleMatches(post.payload, attr)) {
        bump(attr, "true");
      }
    }
    for (const attr of RANGE_ATTRS) {
      for (const value of numericValues(post, attr)) {
        noteStat(attr, value);
      }
    }
  }
  return { facets, stats };
}

export function mergeFacetCounts(
  left: FacetCounts,
  right: FacetCounts,
): FacetCounts {
  const out: FacetCounts = {};
  for (const source of [left, right]) {
    for (const [attr, bucket] of Object.entries(source)) {
      const dest = out[attr] ?? (out[attr] = {});
      for (const [value, count] of Object.entries(bucket)) {
        dest[value] = (dest[value] ?? 0) + count;
      }
    }
  }
  return out;
}

export function mergeFacetStats(left: FacetStats, right: FacetStats): FacetStats {
  const out: FacetStats = { ...left };
  for (const [attr, stat] of Object.entries(right)) {
    const prev = out[attr];
    if (!prev) {
      out[attr] = { ...stat };
      continue;
    }
    const min =
      typeof prev.min === "number" && typeof stat.min === "number"
        ? Math.min(prev.min, stat.min)
        : (prev.min ?? stat.min);
    const max =
      typeof prev.max === "number" && typeof stat.max === "number"
        ? Math.max(prev.max, stat.max)
        : (prev.max ?? stat.max);
    out[attr] = { ...prev, min, max };
  }
  return out;
}

export function mergeSearchFacets(left: SearchFacets, right: SearchFacets): SearchFacets {
  return {
    facets: mergeFacetCounts(left.facets, right.facets),
    stats: mergeFacetStats(left.stats, right.stats),
  };
}

/** Effective sidebar sort from handleCannySearch (`filters.sort`), else Canny's `sort`. */
export function readSortKey(body: CannySearchBody): string {
  return readString(body.filters?.sort) || readString(body.sort);
}
