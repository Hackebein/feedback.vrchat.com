/**
 * Builds OpenSearch DSL for Lucene / query_string queries, splitting top-level AND
 * and routing comments.* clauses into nested "any comment matches" queries.
 *
 * Repeated equalities on the same enum field (status, author, voters, …) are
 * rewritten to OR before that split. See `ENUM_FIELDS`.
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
 * Keyword / enum fields whose repeated equalities are OR, matching the sidebar
 * checkbox lists. Text and `.keyword` forms stay separate groups.
 * Keep in sync with `LUCENE_HELP_ROWS` in the userscript.
 */
const ENUM_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "author.name",
  "author.name.keyword",
  "voters.name",
  "voters.name.keyword",
  "board.name",
  "board.name.keyword",
  "board.urlName",
  "category.name",
  "category.name.keyword",
  "aiCategories",
  "aiCategories.keyword",
  "comments.author.name",
  "comments.author.name.keyword",
]);

type Token =
  | { kind: "and" | "or" | "not" | "lparen" | "rparen" }
  | { kind: "atom"; text: string };

type QueryNode =
  | { kind: "atom"; text: string }
  | { kind: "not"; child: QueryNode }
  | { kind: "and"; children: QueryNode[] }
  | { kind: "or"; children: QueryNode[] };

function matchKeyword(
  input: string,
  index: number,
): { kind: "and" | "or" | "not"; next: number } | undefined {
  if (input.startsWith("&&", index)) {
    return { kind: "and", next: index + 2 };
  }
  if (input.startsWith("||", index)) {
    return { kind: "or", next: index + 2 };
  }
  const match = /^((?:AND|OR|NOT))\b/i.exec(input.slice(index));
  if (!match) {
    return undefined;
  }
  const word = match[1]!.toLowerCase();
  if (word === "and" || word === "or" || word === "not") {
    return { kind: word, next: index + match[1]!.length };
  }
  return undefined;
}

function readQuoted(input: string, start: number): { text: string; next: number } {
  const quote = input[start] ?? '"';
  let index = start + 1;
  let text = quote;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (char === "\\" && index + 1 < input.length) {
      text += char + (input[index + 1] ?? "");
      index += 2;
      continue;
    }
    text += char;
    index += 1;
    if (char === quote) {
      break;
    }
  }
  return { text, next: index };
}

function readBalanced(
  input: string,
  start: number,
  open: string,
  close: string,
): { text: string; next: number } {
  let depth = 0;
  let index = start;
  let text = "";
  let quote: string | undefined;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (quote) {
      text += char;
      if (char === "\\" && index + 1 < input.length) {
        text += input[index + 1] ?? "";
        index += 2;
        continue;
      }
      index += 1;
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      text += char;
      index += 1;
      continue;
    }
    text += char;
    index += 1;
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  return { text, next: index };
}

function readAtom(input: string, start: number): { text: string; next: number } {
  let index = start;
  let text = "";
  while (index < input.length) {
    const char = input[index] ?? "";
    if (char === '"' || char === "'") {
      const quoted = readQuoted(input, index);
      text += quoted.text;
      index = quoted.next;
      continue;
    }
    if (char === "[") {
      const bracket = readBalanced(input, index, "[", "]");
      text += bracket.text;
      index = bracket.next;
      continue;
    }
    if (char === "(") {
      if (/[A-Za-z_][\w.]*\s*:\s*$/.test(text)) {
        const group = readBalanced(input, index, "(", ")");
        text += group.text;
        index = group.next;
        continue;
      }
      break;
    }
    if (char === ")" || /\s/.test(char)) {
      break;
    }
    if (text.length > 0 && (input.startsWith("&&", index) || input.startsWith("||", index))) {
      break;
    }
    text += char;
    index += 1;
  }
  return { text, next: index };
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const keyword = matchKeyword(input, index);
    if (keyword) {
      tokens.push({ kind: keyword.kind });
      index = keyword.next;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen" });
      index += 1;
      continue;
    }
    const atom = readAtom(input, index);
    if (atom.text) {
      tokens.push({ kind: "atom", text: atom.text });
    }
    index = atom.next > index ? atom.next : index + 1;
  }
  return tokens;
}

/** Field name when `atom` is a plain enum equality (`field:term` or `field:"phrase"`). */
function enumFieldOf(atom: string): string | undefined {
  const match = /^([A-Za-z_][\w.]*)\s*:([\s\S]+)$/.exec(atom);
  if (!match) {
    return undefined;
  }
  const field = match[1]!;
  const value = match[2]!;
  if (!ENUM_FIELDS.has(field) || !isSimpleEnumValue(value)) {
    return undefined;
  }
  return field;
}

function isSimpleEnumValue(value: string): boolean {
  if (value.startsWith("[") || value.startsWith("(")) {
    return false;
  }
  if (value.includes("^") || value.includes("~")) {
    return false;
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]!;
    return value.length >= 2 && value.endsWith(quote) && !value.slice(1, -1).includes(quote);
  }
  return /^[^\s()[\]]+$/.test(value);
}

function parseQuery(tokens: Token[]): QueryNode {
  let index = 0;

  function peek(): Token | undefined {
    return tokens[index];
  }

  function parseOr(): QueryNode {
    const children = [parseAnd()];
    while (peek()?.kind === "or") {
      index += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0]! : { kind: "or", children };
  }

  function parseAnd(): QueryNode {
    const children = [parseNot()];
    while (true) {
      const next = peek();
      if (!next || next.kind === "or" || next.kind === "rparen") {
        break;
      }
      if (next.kind === "and") {
        index += 1;
        children.push(parseNot());
        continue;
      }
      if (next.kind === "atom" || next.kind === "not" || next.kind === "lparen") {
        children.push(parseNot());
        continue;
      }
      break;
    }
    const present = children.filter((child) => child.kind !== "atom" || child.text.length > 0);
    if (present.length === 0) {
      return { kind: "atom", text: "" };
    }
    return present.length === 1 ? present[0]! : { kind: "and", children: present };
  }

  function parseNot(): QueryNode {
    if (peek()?.kind === "not") {
      index += 1;
      return { kind: "not", child: parseNot() };
    }
    return parsePrimary();
  }

  function parsePrimary(): QueryNode {
    const token = peek();
    if (!token) {
      return { kind: "atom", text: "" };
    }
    if (token.kind === "lparen") {
      index += 1;
      const inner = parseOr();
      if (peek()?.kind === "rparen") {
        index += 1;
      }
      return inner;
    }
    if (token.kind === "atom") {
      index += 1;
      return { kind: "atom", text: token.text };
    }
    index += 1;
    return { kind: "atom", text: "" };
  }

  return parseOr();
}

function foldEnums(node: QueryNode): QueryNode {
  switch (node.kind) {
    case "atom":
      return node;
    case "not":
      return { kind: "not", child: foldEnums(node.child) };
    case "or":
      return joinNodes("or", node.children.map(foldEnums));
    case "and":
      return groupEnumEqualities(node.children.map(foldEnums));
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

function joinNodes(kind: "and" | "or", children: QueryNode[]): QueryNode {
  if (children.length === 0) {
    return { kind: "atom", text: "" };
  }
  if (children.length === 1) {
    return children[0]!;
  }
  return { kind, children };
}

/** Collapse repeated plain equalities of one enum field inside a single AND-chain. */
function groupEnumEqualities(children: QueryNode[]): QueryNode {
  const indexesByField = new Map<string, number[]>();
  children.forEach((child, childIndex) => {
    if (child.kind !== "atom") {
      return;
    }
    const field = enumFieldOf(child.text);
    if (!field) {
      return;
    }
    const indexes = indexesByField.get(field) ?? [];
    indexes.push(childIndex);
    indexesByField.set(field, indexes);
  });

  const drop = new Set<number>();
  const replacements = new Map<number, QueryNode>();
  for (const indexes of indexesByField.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const first = indexes[0]!;
    replacements.set(first, {
      kind: "or",
      children: indexes.map((childIndex) => children[childIndex]!),
    });
    for (const childIndex of indexes.slice(1)) {
      drop.add(childIndex);
    }
  }

  const next: QueryNode[] = [];
  children.forEach((child, childIndex) => {
    if (drop.has(childIndex)) {
      return;
    }
    next.push(replacements.get(childIndex) ?? child);
  });
  return joinNodes("and", next);
}

function printNode(node: QueryNode): string {
  switch (node.kind) {
    case "atom":
      return node.text;
    case "not": {
      const inner = printNode(node.child);
      const wrapped =
        node.child.kind === "and" || node.child.kind === "or" ? `(${inner})` : inner;
      return inner ? `NOT ${wrapped}` : "NOT";
    }
    case "and":
      return node.children
        .map((child) => {
          const text = printNode(child);
          return child.kind === "or" ? `(${text})` : text;
        })
        .filter((text) => text.length > 0)
        .join(" AND ");
    case "or":
      return node.children
        .map((child) => {
          const text = printNode(child);
          return child.kind === "and" ? `(${text})` : text;
        })
        .filter((text) => text.length > 0)
        .join(" OR ");
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

/**
 * OR repeated plain equalities of the same enum field. AND still binds tighter
 * than OR. Ranges, `field:(...)`, boosts, fuzzy terms, and `NOT` stay as written.
 */
export function rewriteEnumOr(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) {
    return "";
  }
  return printNode(foldEnums(parseQuery(tokenize(trimmed))));
}

/**
 * Parses the full user Lucene string into post-level query_string segments and nested comment segments.
 */
export function buildLuceneQueryBody(trimmedQuery: string): ElasticsearchQuery {
  if (!trimmedQuery) {
    return { match_all: {} };
  }

  const chunks = splitTopLevelAnd(rewriteEnumOr(trimmedQuery));
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
