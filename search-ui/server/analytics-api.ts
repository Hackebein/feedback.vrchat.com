import type { ElasticsearchQuery } from "searchkit";
import { buildAnalytics, type AnalyticsReport, type HistoryPost } from "../../shared/status-analytics";
import type { OpenSearchTarget } from "./agent-api";

const FILTER_KEYS = ["query", "facetFilters", "numericFilters", "filters", "tagFilters"] as const;
const SOURCE = ["post_id", "title", "urlName", "board.urlName", "status", "created", "statusChanged", "comments._id", "comments.statusChangeID", "comments.statusChangeNewStatus", "comments.created", "comments.deleted", "comments.spam", "comments.private", "comments.internal", "comments.mergeID"];
const MAX_POSTS = 100_000;
export class AnalyticsError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export function parseAnalyticsParams(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AnalyticsError("Expected an object with search params", 400);
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new AnalyticsError("Expected search params", 400);
  if (JSON.stringify(params).length > 16_384) throw new AnalyticsError("Search filter is too large", 400);
  const result: Record<string, unknown> = {};
  for (const key of FILTER_KEYS) {
    const value = (params as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (key === "query" || key === "filters") {
      if (typeof value !== "string") throw new AnalyticsError(`Invalid ${key}`, 400);
    } else {
      const list = typeof value === "string" && key === "tagFilters" ? [value] : value;
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string" && (!Array.isArray(item) || item.some((part) => typeof part !== "string")))) throw new AnalyticsError(`Invalid ${key}`, 400);
      if (key === "numericFilters" && list.some(Array.isArray)) throw new AnalyticsError("Invalid numericFilters", 400);
    }
    result[key] = value;
  }
  return result;
}

// Searchkit adds inner_hits for nested filters. Membership is unchanged without them,
// and analytics needs only the explicit public history fields from _source.
export function withoutInnerHits(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutInnerHits);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "inner_hits").map(([key, child]) => [key, withoutInnerHits(child)]));
}

export async function scanAnalyticsPosts(target: OpenSearchTarget, query: ElasticsearchQuery): Promise<HistoryPost[]> {
  const base = target.opensearchUrl.replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${target.opensearchUser}:${target.opensearchPassword}`).toString("base64") };
  const signal = AbortSignal.timeout(60_000);
  const posts: HistoryPost[] = [];
  const seen = new Set<string>();
  let expected: number | undefined;
  let cursor: string[] | undefined;
  // Published backing indices are immutable. A fixed index and unique post_id sort
  // give a consistent scan without scroll/PIT contexts, which production disables.
  while (true) {
    const body = { query: withoutInnerHits(query), size: 500, sort: [{ post_id: "asc" }], track_total_hits: expected === undefined, _source: SOURCE, ...(cursor ? { search_after: cursor } : {}) };
    const response = await fetch(`${base}/${encodeURIComponent(target.index)}/_search`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new AnalyticsError(`Analytics search failed (${response.status})`);
    const data = await response.json() as {
      timed_out?: boolean; _shards?: { failed?: number };
      hits?: { total?: number | { value: number; relation: string }; hits?: Array<{ _source?: HistoryPost; sort?: unknown[] }> };
    };
    if (data.timed_out || (data._shards?.failed ?? 0) > 0) throw new AnalyticsError("Analytics search was incomplete; please retry");
    if (expected === undefined) {
      const total = data.hits?.total;
      if (typeof total === "object" && total !== null && total.relation !== "eq") throw new AnalyticsError("Analytics search did not return an exact total");
      expected = typeof total === "number" ? total : total?.value;
      if (expected === undefined) throw new AnalyticsError("Analytics search returned no total");
      if (expected > MAX_POSTS) throw new AnalyticsError(`Analytics supports up to ${MAX_POSTS.toLocaleString("en-US")} posts per filter; narrow the current filter`, 422);
    }
    const hits = data.hits?.hits;
    if (!Array.isArray(hits)) throw new AnalyticsError("Analytics search returned no hits");
    for (const hit of hits) {
      const id = hit._source?.post_id;
      if (!hit._source || !id || seen.has(id)) throw new AnalyticsError("Analytics search returned an incomplete or repeated post");
      seen.add(id);
      posts.push(hit._source);
    }
    if (posts.length > MAX_POSTS || posts.length > expected) throw new AnalyticsError("Analytics search returned an inconsistent total");
    if (posts.length === expected) return posts;
    if (!hits.length) throw new AnalyticsError("Analytics search was incomplete; please retry");
    const next = hits[hits.length - 1]!.sort;
    if (!next || next.length !== 1 || typeof next[0] !== "string" || next[0] === cursor?.[0]) throw new AnalyticsError("Analytics search returned no advancing pagination cursor");
    cursor = [next[0]];
  }
}

export function createAnalyticsService(options: {
  target: OpenSearchTarget;
  resolveIndex: () => Promise<string>;
  compile: (params: Record<string, unknown>, lucene: boolean, index: string) => Promise<ElasticsearchQuery>;
}) {
  const cache = new Map<string, { until: number; result: Promise<AnalyticsReport> }>();
  let active = 0;
  return async (params: Record<string, unknown>, lucene: boolean): Promise<AnalyticsReport> => {
    const index = await options.resolveIndex();
    const key = JSON.stringify([index, lucene, params]);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.until > now) return cached.result;
    for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
    if (active >= 2) throw new AnalyticsError("Analytics is busy; please retry shortly", 429);
    active++;
    const result = (async () => {
      try {
        const query = await options.compile(params, lucene, index);
        const posts = await scanAnalyticsPosts({ ...options.target, index }, query);
        return buildAnalytics(posts, now, index);
      } finally { active--; }
    })();
    while (cache.size >= 16) cache.delete(cache.keys().next().value!);
    const entry = { until: now + 120_000, result };
    cache.set(key, entry);
    try { return await result; }
    catch (error) { if (cache.get(key) === entry) cache.delete(key); throw error; }
  };
}
