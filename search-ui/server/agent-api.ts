import type { ElasticsearchQuery } from "searchkit";
import { parseNonNegativeInt, parsePositiveInt } from "./http-params";
import {
  instantSearchStrictQuery,
  textSearchAttributes,
} from "./searchkit-config";

export const FEEDBACK_ORIGIN = "https://feedback.vrchat.com";

/** RFC 8288 link to the machine contract and the human API reference. */
export const SERVICE_LINK =
  '</openapi.json>; rel="service-desc"; type="application/openapi+json", </openapi.html>; rel="service-doc"';

export const AGENT_SEARCH_DEFAULT_LIMIT = 10;
export const AGENT_SEARCH_MAX_LIMIT = 20;
export const AGENT_SNIPPET_CHARS = 200;
export const AGENT_DETAILS_CHARS = 4000;
export const AGENT_COMMENT_CHARS = 500;
export const AGENT_COMMENT_LIMIT = 8;
/** Matches `index.max_result_window` in the OpenSearch index settings. */
export const AGENT_MAX_RESULT_WINDOW = 50000;

const AGENT_HIT_SOURCE = [
  "post_id",
  "title",
  "urlName",
  "board.urlName",
  "status",
  "score",
  "commentCount",
  "created",
] as const;

const AGENT_POST_SOURCE = [
  ...AGENT_HIT_SOURCE,
  "details",
  "comments.pinned",
  "comments.value",
  "comments.created",
  "comments.author.name",
  "comments.deleted",
  "comments.internal",
  "comments.private",
  "comments.spam",
] as const;

export type AgentFields = {
  post_id?: string;
  title?: string;
  url?: string;
  board?: string;
  status?: string;
  score?: number;
  commentCount?: number;
  created?: string;
};

export type AgentHit = AgentFields & {
  snippet: string;
};

export type AgentComment = {
  author?: string;
  created?: string;
  pinned: boolean;
  value: string;
  valueTruncated: boolean;
};

export type AgentPost = AgentFields & {
  details?: string;
  detailsTruncated?: boolean;
  comments: AgentComment[];
};

export type AgentSearchParams = {
  q: string;
  board?: string;
  status?: string;
  limit: number;
  page: number;
};

export type AgentSearchResponse = {
  q: string;
  board?: string;
  status?: string;
  page: number;
  limit: number;
  nbHits: number;
  hits: AgentHit[];
};

export type OpenSearchTarget = {
  opensearchUrl: string;
  opensearchUser: string;
  opensearchPassword: string;
  index: string;
};

export type OpenSearchCall =
  | { ok: true; body: unknown }
  | { ok: false; httpStatus: 400 | 500; message: string; detail?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readQueryString(
  raw: unknown,
): { ok: true; value: string } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, value: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  return { ok: true, value: raw.trim() };
}

function feedbackPostUrl(board: string, urlName: string): string {
  return `${FEEDBACK_ORIGIN}/${encodeURIComponent(board)}/p/${encodeURIComponent(urlName)}`;
}

function readBoardSlug(source: Record<string, unknown>): string | undefined {
  if (!isRecord(source.board)) {
    return undefined;
  }
  return readString(source.board.urlName);
}

function agentFields(source: Record<string, unknown>): AgentFields {
  const board = readBoardSlug(source);
  const urlName = readString(source.urlName);
  const fields: AgentFields = {};
  const postId = readString(source.post_id);
  const title = readString(source.title);
  const status = readString(source.status);
  const score = readNumber(source.score);
  const commentCount = readNumber(source.commentCount);
  const created = readString(source.created);
  if (postId !== undefined) {
    fields.post_id = postId;
  }
  if (title !== undefined) {
    fields.title = title;
  }
  if (board !== undefined && urlName !== undefined) {
    fields.url = feedbackPostUrl(board, urlName);
  }
  if (board !== undefined) {
    fields.board = board;
  }
  if (status !== undefined) {
    fields.status = status;
  }
  if (score !== undefined) {
    fields.score = score;
  }
  if (commentCount !== undefined) {
    fields.commentCount = commentCount;
  }
  if (created !== undefined) {
    fields.created = created;
  }
  return fields;
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, max), truncated: true };
}

function highlightSnippet(hit: Record<string, unknown>): string {
  if (!isRecord(hit.highlight) || !Array.isArray(hit.highlight.details)) {
    return "";
  }
  const first = hit.highlight.details.find((part) => typeof part === "string");
  if (typeof first !== "string") {
    return "";
  }
  const plain = first
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .trim();
  return truncateText(plain, AGENT_SNIPPET_CHARS).text;
}

function readSearchHits(body: unknown): { total: number; hits: unknown[] } {
  if (!isRecord(body) || !isRecord(body.hits) || !Array.isArray(body.hits.hits)) {
    throw new Error("OpenSearch search returned no hits array");
  }
  const total = body.hits.total;
  if (!isRecord(total) || typeof total.value !== "number") {
    throw new Error("OpenSearch search returned no hit total");
  }
  return { total: total.value, hits: body.hits.hits };
}

function readHitSource(hit: unknown): Record<string, unknown> {
  if (!isRecord(hit) || !isRecord(hit._source)) {
    throw new Error("OpenSearch hit missing _source");
  }
  return hit._source;
}

export function parseAgentSearchQuery(
  query: Record<string, unknown>,
): { ok: true; params: AgentSearchParams } | { ok: false; message: string } {
  const q = readQueryString(query.q);
  if (!q.ok) {
    return { ok: false, message: "invalid q" };
  }
  const board = readQueryString(query.board);
  if (!board.ok) {
    return { ok: false, message: "invalid board" };
  }
  const status = readQueryString(query.status);
  if (!status.ok) {
    return { ok: false, message: "invalid status" };
  }
  const limit = parsePositiveInt(
    query.limit,
    AGENT_SEARCH_DEFAULT_LIMIT,
    AGENT_SEARCH_MAX_LIMIT,
  );
  const page = parseNonNegativeInt(query.page, 0, 9999);
  if (page * limit >= AGENT_MAX_RESULT_WINDOW) {
    return { ok: false, message: "page is past the result window" };
  }
  return {
    ok: true,
    params: {
      q: q.value,
      ...(board.value ? { board: board.value } : {}),
      ...(status.value ? { status: status.value } : {}),
      limit,
      page,
    },
  };
}

export function buildAgentSearchBody(params: AgentSearchParams): Record<string, unknown> {
  const text = instantSearchStrictQuery(params.q, textSearchAttributes);
  const filter: ElasticsearchQuery[] = [];
  if (params.board) {
    filter.push({ term: { "board.urlName": params.board } });
  }
  if (params.status) {
    filter.push({ term: { status: params.status } });
  }
  const query: ElasticsearchQuery =
    filter.length === 0 ? text : { bool: { must: [text], filter } };
  const sort =
    params.q.length === 0
      ? [{ created: "desc" }]
      : [{ _score: "desc" }, { created: "desc" }];
  return {
    from: params.page * params.limit,
    size: params.limit,
    track_total_hits: true,
    _source: [...AGENT_HIT_SOURCE],
    query,
    sort,
    highlight: {
      pre_tags: [""],
      post_tags: [""],
      fields: {
        details: {
          fragment_size: AGENT_SNIPPET_CHARS,
          number_of_fragments: 1,
          no_match_size: AGENT_SNIPPET_CHARS,
        },
      },
    },
  };
}

export function buildAgentPostBody(board: string, urlName: string): Record<string, unknown> {
  return {
    size: 1,
    _source: [...AGENT_POST_SOURCE],
    query: {
      bool: {
        filter: [
          { term: { "board.urlName": board } },
          { term: { urlName } },
        ],
      },
    },
  };
}

export function mapAgentSearchResponse(
  body: unknown,
  params: AgentSearchParams,
): AgentSearchResponse {
  const parsed = readSearchHits(body);
  const hits = parsed.hits.map((hit) => {
    if (!isRecord(hit)) {
      throw new Error("OpenSearch hit missing _source");
    }
    return {
      ...agentFields(readHitSource(hit)),
      snippet: highlightSnippet(hit),
    };
  });
  return {
    q: params.q,
    ...(params.board ? { board: params.board } : {}),
    ...(params.status ? { status: params.status } : {}),
    page: params.page,
    limit: params.limit,
    nbHits: parsed.total,
    hits,
  };
}

function commentHidden(row: Record<string, unknown>): boolean {
  return (
    row.deleted === true ||
    row.internal === true ||
    row.private === true ||
    row.spam === true
  );
}

function agentComments(source: Record<string, unknown>): AgentComment[] {
  if (!Array.isArray(source.comments)) {
    return [];
  }
  const visible = source.comments.flatMap((comment, index) => {
    if (!isRecord(comment) || commentHidden(comment)) {
      return [];
    }
    const value = readString(comment.value);
    if (value === undefined || value.trim().length === 0) {
      return [];
    }
    return [{ comment, index, value }];
  });
  visible.sort((a, b) => {
    const pinnedDelta = Number(b.comment.pinned === true) - Number(a.comment.pinned === true);
    if (pinnedDelta !== 0) {
      return pinnedDelta;
    }
    const aCreated = readString(a.comment.created) ?? "";
    const bCreated = readString(b.comment.created) ?? "";
    if (aCreated !== bCreated) {
      return aCreated < bCreated ? 1 : -1;
    }
    return a.index - b.index;
  });
  return visible.slice(0, AGENT_COMMENT_LIMIT).map(({ comment, value }) => {
    const clipped = truncateText(value, AGENT_COMMENT_CHARS);
    const authorRecord = comment.author;
    const author =
      isRecord(authorRecord) ? readString(authorRecord.name)?.trim() : undefined;
    const created = readString(comment.created);
    return {
      ...(author ? { author } : {}),
      ...(created !== undefined ? { created } : {}),
      pinned: comment.pinned === true,
      value: clipped.text,
      valueTruncated: clipped.truncated,
    };
  });
}

export function mapAgentPost(body: unknown): AgentPost | null {
  const parsed = readSearchHits(body);
  const first = parsed.hits[0];
  if (first === undefined) {
    return null;
  }
  const source = readHitSource(first);
  const details = readString(source.details);
  const clipped = details === undefined ? undefined : truncateText(details, AGENT_DETAILS_CHARS);
  return {
    ...agentFields(source),
    ...(clipped
      ? { details: clipped.text, detailsTruncated: clipped.truncated }
      : {}),
    comments: agentComments(source),
  };
}

function errorDetail(parsed: unknown, text: string): string {
  if (isRecord(parsed) && parsed.error !== undefined) {
    return JSON.stringify(parsed.error).slice(0, 500);
  }
  return text.slice(0, 500);
}

export async function queryOpenSearch(
  target: OpenSearchTarget,
  body: unknown,
): Promise<OpenSearchCall> {
  const url = `${target.opensearchUrl.replace(/\/$/, "")}/${encodeURIComponent(target.index)}/_search`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(`${target.opensearchUser}:${target.opensearchPassword}`).toString(
          "base64",
        ),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const detail = errorDetail(parsed, text);
    if (response.status === 400) {
      return { ok: false, httpStatus: 400, message: "Invalid search query", detail };
    }
    return { ok: false, httpStatus: 500, message: "search failed", detail };
  }
  if (parsed === undefined) {
    return { ok: false, httpStatus: 500, message: "search failed" };
  }
  return { ok: true, body: parsed };
}
