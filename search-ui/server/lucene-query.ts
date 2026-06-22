/**
 * Builds OpenSearch DSL for Lucene / query_string queries, splitting top-level AND
 * and routing comments.* clauses into nested "any comment matches" queries.
 */

import type { ElasticsearchQuery } from "searchkit";

const POST_QUERY_STRING_FIELDS = [
  "combined_text^3",
  "title^2",
  "details",
  "author.name",
  "aiCategories",
] as const;

const QUERY_STRING_COMMON = {
  default_operator: "AND" as const,
  lenient: true,
  analyze_wildcard: true,
};

const COMMENTS_PATH = "comments";
const VOTERS_PATH = "voters";

/** Split on whitespace-delimited AND at paren-depth 0, outside quotes. */
export function splitTopLevelAnd(query: string): string[] {
  const q = query.trim();
  if (!q) return [];

  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < q.length; i++) {
    const c = q[i];

    if (quote) {
      buf += c;
      if (c === "\\" && i + 1 < q.length) {
        buf += q[i + 1];
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }

    if (c === "(") {
      depth++;
      buf += c;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      buf += c;
      continue;
    }

    if (depth === 0) {
      const sep = andSeparatorLen(q, i);
      if (sep > 0) {
        const seg = buf.trim();
        if (seg) parts.push(seg);
        buf = "";
        i += sep - 1;
        continue;
      }
    }

    buf += c;
  }

  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts;
}

/** Length from pos over a top-level ` AND ` boundary (requires spaces, avoids `fooANDbar`). */
function andSeparatorLen(q: string, pos: number): number {
  const m = q.slice(pos).match(/^\s+AND\s+/i);
  return m?.[0].length ?? 0;
}

/** Strip successive NOT prefixes (toggle negation for each). */
export function stripNotLayers(s: string): { negated: boolean; rest: string } {
  let rest = s.trim();
  let negated = false;
  let changed = true;
  while (changed) {
    changed = false;
    const m = rest.match(/^NOT\s+/i);
    if (m) {
      negated = !negated;
      rest = rest.slice(m[0].length).trim();
      changed = true;
    }
  }
  return { negated, rest };
}

/** If the whole clause is wrapped in parentheses, unwrap once (quote-aware). */
export function stripOneBalancedParenPair(s: string): string {
  const t = s.trim();
  if (!t.startsWith("(")) {
    return t;
  }

  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quote) {
      if (c === "\\" && i + 1 < t.length) {
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }

    if (c === "(") {
      depth++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0 && i === t.length - 1) {
        return t.slice(1, -1).trim();
      }
      continue;
    }
  }

  return t;
}

/** Unwrap redundant outer parentheses until stable. */
export function stripOuterParens(s: string): string {
  let cur = s.trim();
  let next = stripOneBalancedParenPair(cur);
  while (next !== cur) {
    cur = next;
    next = stripOneBalancedParenPair(cur);
  }
  return cur;
}

const LEADING_FIELD = /^([A-Za-z_][\w.]*)\s*:/;

export type ClauseBucket = "post" | "comments" | "voters";

/** Classifies by the first clause field segment (after NOT / outer parens). */
export function classifyClause(rest: string): { bucket: ClauseBucket; clause: string } {
  const clause = stripOuterParens(rest);
  const fm = clause.match(LEADING_FIELD);
  const field = fm?.[1];
  if (!field) {
    return { bucket: "post", clause };
  }
  if (field === "comments" || field.startsWith("comments.")) {
    return { bucket: "comments", clause };
  }
  if (field === "voters" || field.startsWith("voters.")) {
    return { bucket: "voters", clause };
  }
  return { bucket: "post", clause };
}

function postQueryString(query: string): ElasticsearchQuery {
  return {
    query_string: {
      query,
      ...QUERY_STRING_COMMON,
      fields: [...POST_QUERY_STRING_FIELDS],
    },
  };
}

function nestedQueryString(path: string, query: string): ElasticsearchQuery {
  return {
    nested: {
      path,
      query: {
        query_string: {
          query,
          ...QUERY_STRING_COMMON,
        },
      },
    },
  };
}

function commentsNested(query: string): ElasticsearchQuery {
  return nestedQueryString(COMMENTS_PATH, query);
}

function votersNested(query: string): ElasticsearchQuery {
  return nestedQueryString(VOTERS_PATH, query);
}

/**
 * Parses the full user Lucene string into post-level query_string segments and nested comment segments.
 */
export function buildLuceneQueryBody(trimmedQuery: string): ElasticsearchQuery {
  if (!trimmedQuery) {
    return { match_all: {} };
  }

  const chunks = splitTopLevelAnd(trimmedQuery);
  if (chunks.length === 0) {
    return { match_all: {} };
  }

  const postPositive: string[] = [];
  const postNegative: string[] = [];
  const commentsPositive: string[] = [];
  const commentsNegative: string[] = [];
  const votersPositive: string[] = [];
  const votersNegative: string[] = [];

  for (const rawChunk of chunks) {
    const { negated, rest } = stripNotLayers(rawChunk);
    const trimmedRest = stripOuterParens(rest);
    if (!trimmedRest) continue;

    const { bucket, clause } = classifyClause(trimmedRest);
    const c = clause.trim();
    if (!c) continue;

    const targetNeg = negated;
    if (bucket === "comments") {
      if (targetNeg) commentsNegative.push(c);
      else commentsPositive.push(c);
    } else if (bucket === "voters") {
      if (targetNeg) votersNegative.push(c);
      else votersPositive.push(c);
    } else {
      if (targetNeg) postNegative.push(c);
      else postPositive.push(c);
    }
  }

  if (
    postPositive.length === 0 &&
    commentsPositive.length === 0 &&
    votersPositive.length === 0 &&
    postNegative.length === 0 &&
    commentsNegative.length === 0 &&
    votersNegative.length === 0
  ) {
    return { match_all: {} };
  }

  const usesNestedOrNegativeRouting =
    commentsPositive.length +
      commentsNegative.length +
      votersPositive.length +
      votersNegative.length +
      postNegative.length >
    0;

  if (
    !usesNestedOrNegativeRouting &&
    postPositive.length === 1
  ) {
    return postQueryString(postPositive[0]!);
  }

  if (
    !usesNestedOrNegativeRouting &&
    postPositive.length > 1
  ) {
    return postQueryString(postPositive.join(" AND "));
  }

  const must: ElasticsearchQuery[] = [];

  if (postPositive.length > 0) {
    must.push(
      postQueryString(
        postPositive.length === 1 ? postPositive[0]! : postPositive.join(" AND "),
      ),
    );
  }

  for (const c of commentsPositive) {
    must.push(commentsNested(c));
  }

  for (const c of votersPositive) {
    must.push(votersNested(c));
  }

  const must_not: ElasticsearchQuery[] = [];

  for (const c of postNegative) {
    must_not.push(postQueryString(c));
  }

  for (const c of commentsNegative) {
    must_not.push(commentsNested(c));
  }

  for (const c of votersNegative) {
    must_not.push(votersNested(c));
  }

  if (
    must.length === 0 &&
    must_not.length === 0
  ) {
    return { match_all: {} };
  }

  return {
    bool: {
      ...(must.length > 0 ? { must } : {}),
      ...(must_not.length > 0 ? { must_not } : {}),
    },
  };
}
