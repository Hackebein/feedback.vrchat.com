/**
 * Sidebar additional-hit counts (`+N`) send `params.excludeFacet` on a
 * hits-free follow-up query. Searchkit ignores that field, so this hook adds
 * the matching `must_not` before the request reaches OpenSearch.
 */

import type { ElasticsearchQuery, SearchRequest } from "searchkit";
import { facetAttributes } from "./searchkit-config";

export type ExcludeFacet = {
  attribute: string;
  values: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readExcludeFacet(params: unknown): ExcludeFacet | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const exclude = params.excludeFacet;
  if (!isRecord(exclude) || typeof exclude.attribute !== "string") {
    return undefined;
  }
  if (!Array.isArray(exclude.values)) {
    return undefined;
  }
  const values = exclude.values.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!exclude.attribute || values.length === 0) {
    return undefined;
  }
  return { attribute: exclude.attribute, values };
}

function facetField(
  attribute: string,
): { field: string; nestedPath?: string } | undefined {
  for (const facet of facetAttributes) {
    if (facet.attribute !== attribute) {
      continue;
    }
    return { field: facet.field, nestedPath: facet.nestedPath };
  }
  return undefined;
}

/** Posts that already match any of `values` on this facet. */
export function excludeFacetClause(
  attribute: string,
  values: string[],
): ElasticsearchQuery | undefined {
  const facet = facetField(attribute);
  if (!facet || values.length === 0) {
    return undefined;
  }
  const fullField = facet.nestedPath ? `${facet.nestedPath}.${facet.field}` : facet.field;
  const terms: ElasticsearchQuery[] = values.map((value) => ({
    term: { [fullField]: value },
  }));
  const match: ElasticsearchQuery = {
    bool: { should: terms, minimum_should_match: 1 },
  };
  if (!facet.nestedPath) {
    return terms.length === 1 ? terms[0]! : match;
  }
  return { nested: { path: facet.nestedPath, query: match } };
}

export function applyExcludeFacets(requests: SearchRequest[]): SearchRequest[] {
  return requests.map((request) => {
    const exclude = readExcludeFacet(request.request.params);
    if (!exclude) {
      return request;
    }
    const clause = excludeFacetClause(exclude.attribute, exclude.values);
    const query = request.body.query;
    if (!clause || !query?.bool) {
      return request;
    }
    const existing = query.bool.filter;
    const filter = [
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      { bool: { must_not: [clause] } },
    ];
    return {
      ...request,
      body: {
        ...request.body,
        query: {
          ...query,
          bool: {
            ...query.bool,
            filter,
          },
        },
      },
    };
  });
}
