import type { MultipleQueriesQuery } from "searchkit";
import type { FacetMapEntry } from "./searchkit-config.js";

function escapeLuceneQuotedValue(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function luceneQuotedFieldClause(
  field: string,
  value: string,
  negated: boolean,
): string {
  const inner = escapeLuceneQuotedValue(value);
  const body = `${field}:"${inner}"`;
  return negated ? `-${body}` : body;
}

function parseFacetFilterLeaf(leaf: string): {
  negated: boolean;
  attribute: string;
  value: string;
} {
  let s = leaf.trim();
  let negated = false;
  if (s.startsWith("-")) {
    negated = true;
    s = s.slice(1).trim();
  }
  const colon = s.indexOf(":");
  if (colon === -1) {
    throw new Error(`Invalid facet filter (expected attribute:value): ${leaf}`);
  }
  const attribute = s.slice(0, colon).trim();
  const value = s.slice(colon + 1);
  if (!attribute) {
    throw new Error(`Invalid facet filter (empty attribute): ${leaf}`);
  }
  return { negated, attribute, value };
}

function normalizeFacetFiltersToGroups(
  raw: unknown,
): string[][] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return [[raw]];
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return [];
    }
    const first = raw[0];
    if (typeof first === "string") {
      return [raw as string[]];
    }
    if (Array.isArray(first)) {
      return raw as string[][];
    }
  }
  return undefined;
}

function foldableLeaf(
  attribute: string,
  facetMap: Record<string, FacetMapEntry>,
): boolean {
  const meta = facetMap[attribute];
  if (!meta) {
    return false;
  }
  return meta.nestedPath === undefined;
}

function groupHasNestedLeaf(
  group: string[],
  facetMap: Record<string, FacetMapEntry>,
): boolean {
  for (const leaf of group) {
    const { attribute } = parseFacetFilterLeaf(leaf);
    if (!foldableLeaf(attribute, facetMap)) {
      return true;
    }
    const meta = facetMap[attribute];
    if (meta.type !== "string") {
      return true;
    }
  }
  return false;
}

function buildLuceneFromOrOfAndGroups(
  groups: string[][],
  facetMap: Record<string, FacetMapEntry>,
): { lucene: string; remainingGroups: string[][] } | "skip" {
  const multiOr = groups.length > 1;

  if (multiOr) {
    for (const group of groups) {
      if (groupHasNestedLeaf(group, facetMap)) {
        return "skip";
      }
    }
  }

  const orParts: string[] = [];
  const remainingGroups: string[][] = [];

  for (const group of groups) {
    const luceneAnd: string[] = [];
    const nestedLeaves: string[] = [];

    for (const leaf of group) {
      const { negated, attribute, value } = parseFacetFilterLeaf(leaf);
      if (!foldableLeaf(attribute, facetMap)) {
        nestedLeaves.push(leaf);
        continue;
      }
      const meta = facetMap[attribute];
      if (meta.type !== "string") {
        nestedLeaves.push(leaf);
        continue;
      }
      luceneAnd.push(luceneQuotedFieldClause(meta.field, value, negated));
    }

    if (!multiOr && nestedLeaves.length > 0 && luceneAnd.length > 0) {
      remainingGroups.push(nestedLeaves);
      if (luceneAnd.length === 1) {
        orParts.push(luceneAnd[0]);
      } else {
        orParts.push(`(${luceneAnd.join(" AND ")})`);
      }
      continue;
    }

    if (nestedLeaves.length > 0) {
      if (multiOr) {
        return "skip";
      }
      remainingGroups.push(nestedLeaves);
      continue;
    }

    if (luceneAnd.length === 0) {
      continue;
    }
    const one =
      luceneAnd.length === 1 ? luceneAnd[0] : `(${luceneAnd.join(" AND ")})`;
    orParts.push(one);
  }

  if (orParts.length === 0) {
    return { lucene: "", remainingGroups };
  }
  const lucene =
    orParts.length === 1 ? orParts[0] : `(${orParts.join(" OR ")})`;
  return { lucene, remainingGroups };
}

/** Parse numeric filter; returns null if not consumed by this merge (e.g. malformed). */
function tryParseNumericToLucene(
  s: string,
  facetMap: Record<string, FacetMapEntry>,
): string | "nested" | "unknown" {
  const trimmed = s.trim();
  // Comparative: field>=10
  const cmp = trimmed.match(/^([^:<>=\s]+)\s*(>=|<=|>|<|=)\s*(.+)$/);
  if (cmp) {
    const attribute = cmp[1].trim();
    const op = cmp[2];
    const rhs = cmp[3].trim();
    const meta = facetMap[attribute];
    if (!meta) return "unknown";
    if (meta.nestedPath) return "nested";
    if (meta.type !== "numeric") return "unknown";
    const field = meta.field;
    const num = Number.parseFloat(rhs);
    if (!Number.isFinite(num)) return "unknown";
    const nStr = String(num);
    if (op === ">=") return `${field}:[${nStr} TO *]`;
    if (op === "<=") return `${field}:[* TO ${nStr}]`;
    if (op === ">") return `${field}:{${nStr} TO *}`;
    if (op === "<") return `${field}:{* TO ${nStr}}`;
    if (op === "=") return `${field}:${nStr}`;
    return "unknown";
  }

  // Colon form: field:10 or field:1 TO 10
  const colon = trimmed.indexOf(":");
  if (colon === -1) return "unknown";
  const attribute = trimmed.slice(0, colon).trim();
  const rest = trimmed.slice(colon + 1).trim();
  const meta = facetMap[attribute];
  if (!meta) return "unknown";
  if (meta.nestedPath) return "nested";
  if (meta.type !== "numeric") return "unknown";
  const field = meta.field;

  const rangeM = rest.match(
    /^(.+?)\s+TO\s+(.+)$/i,
  );
  if (rangeM) {
    const a = Number.parseFloat(rangeM[1].trim());
    const b = Number.parseFloat(rangeM[2].trim());
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "unknown";
    return `${field}:[${a} TO ${b}]`;
  }
  const num = Number.parseFloat(rest);
  if (!Number.isFinite(num)) return "unknown";
  return `${field}:${num}`;
}

function mergeNumericFilters(
  raw: unknown,
  facetMap: Record<string, FacetMapEntry>,
): { luceneParts: string[]; remaining: string[] } {
  if (!Array.isArray(raw)) {
    return { luceneParts: [], remaining: [] };
  }
  const luceneParts: string[] = [];
  const remaining: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const out = tryParseNumericToLucene(item, facetMap);
    if (out === "nested" || out === "unknown") {
      remaining.push(item);
    } else {
      luceneParts.push(out);
    }
  }
  return { luceneParts, remaining };
}

function andJoinLucene(parts: string[]): string {
  const nonEmpty = parts.filter((p) => p.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return nonEmpty[0];
  return nonEmpty.map((p) => (p.includes(" OR ") ? `(${p})` : p)).join(" AND ");
}

function appendToQuery(existing: string, fragment: string): string {
  const e = existing.trim();
  const f = fragment.trim();
  if (!f) return e;
  if (!e) return f;
  return `(${e}) AND ${f}`;
}

/**
 * Folds non-nested `facetFilters` and `numericFilters` into `params.query` as Lucene clauses.
 * Nested facet filters stay in `facetFilters` for SearchKit's nested queries.
 */
export function mergeLuceneFilters(
  requests: MultipleQueriesQuery[],
  facetMap: Record<string, FacetMapEntry>,
): void {
  for (const req of requests) {
    const params = req.params as Record<string, unknown>;
    if (!params || typeof params !== "object") continue;

    const existing = typeof params.query === "string" ? params.query : "";
    const fragments: string[] = [];

    const groups = normalizeFacetFiltersToGroups(params.facetFilters);
    if (groups !== undefined) {
      const orAnd = buildLuceneFromOrOfAndGroups(groups, facetMap);
      if (orAnd === "skip") {
        // Leave facetFilters unchanged for SearchKit
      } else {
        const { lucene, remainingGroups } = orAnd;
        if (lucene) fragments.push(lucene);
        if (remainingGroups.length === 0) {
          delete params.facetFilters;
        } else {
          params.facetFilters = remainingGroups;
        }
      }
    }

    const { luceneParts, remaining } = mergeNumericFilters(
      params.numericFilters,
      facetMap,
    );
    for (const p of luceneParts) fragments.push(p);
    if (Array.isArray(params.numericFilters)) {
      if (remaining.length === 0) {
        delete params.numericFilters;
      } else {
        params.numericFilters = remaining;
      }
    }

    const extras = andJoinLucene(fragments);
    params.query = appendToQuery(existing, extras);
  }
}
