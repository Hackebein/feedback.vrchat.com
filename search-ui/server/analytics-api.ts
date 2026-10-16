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
  const signal = AbortSignal.timeout(90_000);
  let scroll: string | undefined;
  const posts: HistoryPost[] = [];
  let expected: number | undefined;
  async function request(path: string, body: unknown) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!response.ok) throw new AnalyticsError(`Analytics search failed (${response.status})`);
    const data = await response.json() as {
      _scroll_id?: string; timed_out?: boolean; _shards?: { failed?: number };
      hits?: { total?: number | { value: number; relation: string }; hits?: Array<{ _source?: HistoryPost }> };
    };
    if (data._scroll_id) scroll = data._scroll_id;
    if (data.timed_out || (data._shards?.failed ?? 0) > 0) throw new AnalyticsError("Analytics search was incomplete; please retry");
    return data;
  }
  try {
    let data = await request(`/${encodeURIComponent(target.index)}/_search?scroll=1m`, { query: withoutInnerHits(query), size: 500, sort: ["_doc"], track_total_hits: true, _source: SOURCE });
    const total = data.hits?.total;
    if (typeof total === "object" && total.relation !== "eq") throw new AnalyticsError("Analytics search did not return an exact total");
    expected = typeof total === "number" ? total : total?.value;
    if (expected === undefined) throw new AnalyticsError("Analytics search returned no total");
    if (expected > MAX_POSTS) throw new AnalyticsError(`Analytics supports up to ${MAX_POSTS.toLocaleString("en-US")} tickets per filter; narrow the current filter`, 422);
    while (true) {
      const hits = data.hits?.hits;
      if (!Array.isArray(hits)) throw new AnalyticsError("Analytics search returned no hits");
      for (const hit of hits) {
        if (!hit._source) throw new AnalyticsError("Analytics search returned an incomplete ticket");
        posts.push(hit._source);
      }
      if (posts.length > MAX_POSTS || posts.length > expected) throw new AnalyticsError("Analytics search returned an inconsistent total");
      if (posts.length === expected) break;
      if (!hits.length || !scroll) throw new AnalyticsError("Analytics search was incomplete; please retry");
      data = await request("/_search/scroll", { scroll: "1m", scroll_id: scroll });
    }
    return posts;
  } finally {
    if (scroll) {
      // Cleanup has its own deadline: the scan's deadline may already have expired.
      await fetch(`${base}/_search/scroll`, { method: "DELETE", headers, body: JSON.stringify({ scroll_id: [scroll] }), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
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
