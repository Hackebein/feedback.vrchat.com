import API from "@searchkit/api";
import type { ElasticsearchQuery, MultipleQueriesQuery, SearchAttribute, SearchRequest } from "searchkit";
import type { OpenSearchTarget } from "./agent-api";
import { AnalyticsError } from "./analytics-api";
import { applyExcludeFacets } from "./facet-exclusion";
import { buildLuceneQueryBody } from "./lucene-query";
import { type PhraseMode, withPhraseFallback } from "./phrase-mode";
import { degradedPlainQuery, instantSearchStrictQuery, rejectTooManyNestedClauses, retryWithoutNestedClauses, searchkitConfig } from "./searchkit-config";

export function extractElasticsearchBadRequestDetail(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const msg = err.message;
  try {
    const parsed = JSON.parse(msg) as { responses?: Array<{ status?: number; error?: unknown }>; status?: number };
    const first = parsed.responses?.[0];
    if (parsed.status === 400 || first?.status === 400) {
      if (first?.error !== undefined && first.error !== null) return typeof first.error === "string" ? first.error : JSON.stringify(first.error);
      return msg;
    }
  } catch { /* not Searchkit JSON */ }
  return /Elasticsearch request failed with status 400\b/.test(msg) ? msg : undefined;
}

export function createSearchService(target: OpenSearchTarget) {
  const apiClient = API(searchkitConfig(target.opensearchUrl, target.opensearchUser, target.opensearchPassword));
  function options(lucene: boolean, mode: PhraseMode, degraded: boolean, transform?: (requests: SearchRequest[]) => SearchRequest[]) {
    return {
      getQuery: lucene ? (query: string) => buildLuceneQueryBody(query.trim(), mode)
        : (query: string, attributes: SearchAttribute[]) => degraded ? degradedPlainQuery(query, attributes, mode) : instantSearchStrictQuery(query, attributes, undefined, mode),
      hooks: {
        beforeSearch: async (requests: SearchRequest[]) => {
          const filtered = applyExcludeFacets(requests);
          return transform ? transform(filtered) : filtered;
        },
        afterSearch: async (_requests: SearchRequest[], responses: any[]) => rejectTooManyNestedClauses(responses),
      },
    };
  }
  async function search(lucene: boolean, requests: MultipleQueriesQuery[], transform?: (requests: SearchRequest[]) => SearchRequest[]) {
    let degraded = false;
    const body = await retryWithoutNestedClauses(lucene, (nextDegraded) => {
      degraded = nextDegraded;
      return withPhraseFallback((mode) => apiClient.handleRequest(requests, options(lucene, mode, nextDegraded, transform)), extractElasticsearchBadRequestDetail);
    });
    return { body, degraded };
  }
  async function compile(params: Record<string, unknown>, lucene: boolean, index: string): Promise<ElasticsearchQuery> {
    let query: ElasticsearchQuery | undefined;
    // Identical settings, nested filters, query modes, and recovery to the Posts request.
    await search(lucene, [{ indexName: target.index, params: { ...params, facets: [], hitsPerPage: 0, page: 0 } }], (requests) => requests.map((request) => {
      query = request.body.query;
      return { ...request, indexName: index, body: { query, size: 0, _source: false, track_total_hits: true } };
    }));
    if (!query) throw new AnalyticsError("Could not compile the current filter");
    return query;
  }
  return { search, compile };
}
