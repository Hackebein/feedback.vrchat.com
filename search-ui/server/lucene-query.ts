/**
 * Builds OpenSearch DSL for Lucene / query_string queries, splitting top-level AND
 * and routing comments.* clauses into nested "any comment matches" queries.
 *
 * Repeated equalities on the same enum field (status, author, voters, …) are
 * rewritten to OR before that split. See `ENUM_FIELDS`.
 */

import type { ElasticsearchQuery } from "searchkit";
import { phraseAnalyzer, phraseSearchFields, type PhraseMode } from "./phrase-mode";

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

type BooleanWord = "AND" | "OR";

/** Length from pos over a top-level ` AND ` / ` OR ` boundary (requires spaces). */
function booleanSeparatorLen(q: string, pos: number, word: BooleanWord): number {
  let pattern: RegExp;
  switch (word) {
    case "AND":
      pattern = /^\s+AND\s+/i;
      break;
    case "OR":
      pattern = /^\s+OR\s+/i;
      break;
    default: {
      const unreachable: never = word;
      return unreachable;
    }
  }
  const match = q.slice(pos).match(pattern);
  return match?.[0].length ?? 0;
}

/** Split on a whitespace-delimited boolean word at paren-depth 0, outside quotes. */
function splitTopLevel(query: string, word: BooleanWord): string[] {
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
      const sep = booleanSeparatorLen(q, i, word);
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

/** Split on whitespace-delimited AND at paren-depth 0, outside quotes. */
export function splitTopLevelAnd(query: string): string[] {
  return splitTopLevel(query, "AND");
}

function splitTopLevelOr(query: string): string[] {
  return splitTopLevel(query, "OR");
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

/**
 * Keyword and boolean fields are stored case-sensitively. Fold the values
 * people actually type (`status:Open`, `comments.pinned:True`) so Lucene
 * matches the indexed term instead of returning nothing.
 */
const CASEFOLD_FIELDS: ReadonlySet<string> = new Set([
  "status",
  "board.urlName",
  "comments.pinned",
  "voteSettings.highEngagement",
  "voteSettings.lowEngagement",
  "voteSettings.moderateEngagement",
]);

const LUCENE_ESCAPES = /[+\-=&|><!(){}\[\]^"~:\\\/]/g;

/** Keep a trailing fuzzy (`~` / `~1`) or boost (`^2`) suffix, escape the rest. */
function splitFuzzyBoost(value: string): { core: string; suffix: string } {
  const match = /^(.*?)((?:~\d*(?:\.\d+)?)?(?:\^\d+(?:\.\d+)?)?)$/.exec(value);
  if (!match) {
    return { core: value, suffix: "" };
  }
  return { core: match[1] ?? "", suffix: match[2] ?? "" };
}

function escapeLuceneCore(core: string): string {
  return core.replace(LUCENE_ESCAPES, (char) => `\\${char}`);
}

function casefoldQuoted(value: string): string {
  const quote = value[0] ?? "";
  if ((quote !== '"' && quote !== "'") || value.length < 2 || !value.endsWith(quote)) {
    return value.toLowerCase();
  }
  return `${quote}${value.slice(1, -1).toLowerCase()}${quote}`;
}

/** Boolean words inside a grouped value keep their spelling. Other words fold. */
const GROUP_OPERATORS: ReadonlySet<string> = new Set(["and", "or", "not", "to"]);

const BARE_PHRASE_FIELDS = ["combined_text^3", "title^2", "details", "author.name"] as const;

/**
 * Quoted phrases on these fields must not run `synonym_graph`. `query_string`
 * would, so `"full body tracking"` matched an `fbt` post.
 */
function postPhraseFields(field: string): readonly string[] | undefined {
  switch (field) {
    case "title":
      return ["title^2"];
    case "details":
      return ["details"];
    case "combined_text":
      return ["combined_text^3"];
    case "author.name":
      return ["author.name"];
    default:
      return undefined;
  }
}

const COMMENT_PHRASE_FIELDS: ReadonlySet<string> = new Set([
  "comments.value",
  "comments.mergedPostTitle",
  "comments.mergedPostDetails",
]);

function unquotePhrase(value: string): string | undefined {
  const match = /^(["'])([\s\S]*)\1$/.exec(value);
  if (!match) {
    return undefined;
  }
  const inner = (match[2] ?? "").trim();
  const quote = match[1] ?? "";
  if (!inner || inner.includes(quote)) {
    return undefined;
  }
  return inner;
}

function readPhraseClause(clause: string): { phrase: string; field: string } | undefined {
  const trimmed = clause.trim();
  const bare = unquotePhrase(trimmed);
  if (bare) {
    return { phrase: bare, field: "" };
  }
  const split = /^([A-Za-z_][\w.]*)\s*:(.*)$/s.exec(trimmed);
  if (!split) {
    return undefined;
  }
  const phrase = unquotePhrase((split[2] ?? "").trim());
  if (!phrase) {
    return undefined;
  }
  return { phrase, field: split[1] ?? "" };
}

function phraseMultiMatch(
  phrase: string,
  fields: readonly string[],
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
  return {
    multi_match: {
      query: phrase,
      type: "phrase",
      fields: phraseSearchFields(fields, mode),
      analyzer: phraseAnalyzer(mode),
    },
  };
}

/**
 * A chunk that is only `"phrase"` or `textField:"phrase"` is a phrase query
 * on `text_phrase` (stem, no synonyms). Keyword quotes stay in `query_string`.
 */
function postPhraseQuery(
  clause: string,
  mode: PhraseMode = "strict",
): ElasticsearchQuery | undefined {
  const read = readPhraseClause(clause);
  if (!read) {
    return undefined;
  }
  const fields = read.field ? postPhraseFields(read.field) : BARE_PHRASE_FIELDS;
  if (!fields) {
    return undefined;
  }
  return phraseMultiMatch(read.phrase, fields, mode);
}

const EXACT_SUBFIELDS = ["combined_text", "title", "details", "author.name"] as const;

/**
 * `groupIds~1` is rewritten to an OR of `.exact` fields. Compiling that OR as
 * its own bool clause keeps `status:open AND groupIds~1` from matching every
 * open post (Lucene binds AND tighter than OR inside one query_string).
 */
function exactFuzzyDisjunction(clause: string): ElasticsearchQuery | undefined {
  const parts = splitTopLevelOr(stripOuterParens(clause));
  if (parts.length !== EXACT_SUBFIELDS.length) {
    return undefined;
  }
  const terms: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const match = /^([A-Za-z_][\w.]*)\.exact:(.+)$/s.exec(parts[index] ?? "");
    if (!match || match[1] !== EXACT_SUBFIELDS[index]) {
      return undefined;
    }
    terms.push((match[2] ?? "").trim());
  }
  const term = terms[0] ?? "";
  if (!term || terms.some((value) => value !== term) || !/[~*?]/.test(term)) {
    return undefined;
  }
  return {
    bool: {
      should: EXACT_SUBFIELDS.map((name) => postQueryString(`${name}.exact:${term}`)),
      minimum_should_match: 1,
    },
  };
}

function containsTextPhrase(clause: string): boolean {
  const text = stripOuterParens(clause.trim());
  if (!text) {
    return false;
  }
  if (postPhraseQuery(text)) {
    return true;
  }
  const orParts = splitTopLevelOr(text);
  if (orParts.length > 1) {
    return orParts.some((part) => containsTextPhrase(part));
  }
  const andParts = splitTopLevelAnd(text);
  if (andParts.length > 1) {
    return andParts.some((part) => containsTextPhrase(part));
  }
  return false;
}

function compileSpecial(
  clause: string,
  mode: PhraseMode = "strict",
): ElasticsearchQuery | undefined {
  const text = stripOuterParens(clause);
  const phrase = postPhraseQuery(text, mode);
  if (phrase) {
    return phrase;
  }
  const fuzzy = exactFuzzyDisjunction(text);
  if (fuzzy) {
    return fuzzy;
  }
  const orParts = splitTopLevelOr(text);
  if (orParts.length > 1 && orParts.some((part) => containsTextPhrase(part))) {
    return {
      bool: {
        should: orParts.map(
          (part) => compileSpecial(part, mode) ?? postQueryString(stripOuterParens(part)),
        ),
        minimum_should_match: 1,
      },
    };
  }
  const andParts = splitTopLevelAnd(text);
  if (
    andParts.length > 1 &&
    andParts.some(
      (part) => containsTextPhrase(part) || exactFuzzyDisjunction(stripOuterParens(part)),
    )
  ) {
    return postTextQuery(andParts, mode);
  }
  return undefined;
}

function postTextQuery(chunks: string[], mode: PhraseMode = "strict"): ElasticsearchQuery {
  const parts: ElasticsearchQuery[] = [];
  const strings: string[] = [];
  const flush = (): void => {
    if (strings.length === 0) {
      return;
    }
    const text =
      strings.length === 1
        ? strings[0]!
        : strings
            .map((chunk) => {
              const clause = stripOuterParens(chunk);
              return splitTopLevelOr(clause).length > 1 ? `(${clause})` : clause;
            })
            .join(" AND ");
    parts.push(postQueryString(text));
    strings.length = 0;
  };
  for (const chunk of chunks) {
    const special = compileSpecial(chunk, mode);
    if (special) {
      flush();
      parts.push(special);
      continue;
    }
    strings.push(chunk);
  }
  flush();
  if (parts.length === 0) {
    return { match_all: {} };
  }
  if (parts.length === 1) {
    return parts[0]!;
  }
  return { bool: { must: parts } };
}

function commentsClauseQuery(clause: string, mode: PhraseMode = "strict"): ElasticsearchQuery {
  const read = readPhraseClause(clause);
  if (read && COMMENT_PHRASE_FIELDS.has(read.field)) {
    return {
      nested: {
        path: COMMENTS_PATH,
        query: phraseMultiMatch(read.phrase, [read.field], mode),
      },
    };
  }
  return commentsNested(clause);
}

/** Lowercase letter-words inside `()`, `[]`, or `{}`. Operators stay as written. */
function casefoldGroup(value: string): string {
  let out = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index] ?? "";
    if (char === '"' || char === "'") {
      const end = value.indexOf(char, index + 1);
      const stop = end === -1 ? value.length : end;
      out += char + value.slice(index + 1, stop).toLowerCase();
      if (end !== -1) {
        out += char;
      }
      index = end === -1 ? value.length : end + 1;
      continue;
    }
    if (/[A-Za-z]/.test(char)) {
      let end = index + 1;
      while (end < value.length && /[A-Za-z]/.test(value[end] ?? "")) {
        end += 1;
      }
      const word = value.slice(index, end);
      out += GROUP_OPERATORS.has(word.toLowerCase()) ? word : word.toLowerCase();
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Escape Lucene operators that appear inside a term (`vrc+`, `C++`, URLs)
 * without touching wildcards or fuzzy/boost suffixes. Grouped values on
 * case-sensitive fields are folded in place (`status:(Open OR Closed)`).
 */
function normalizeLuceneValue(value: string, casefold: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith("(")) {
    return casefold ? casefoldGroup(trimmed) : trimmed;
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return casefold ? casefoldQuoted(trimmed) : trimmed;
  }
  const split = splitFuzzyBoost(trimmed);
  const core = casefold ? split.core.toLowerCase() : split.core;
  return escapeLuceneCore(core) + split.suffix;
}

/**
 * A fuzzy or wildcard identifier is analyzed before `~` / `*` applies. The
 * search analyzer splits `groupIds` into `group` and `id`, so `groupIds~1`
 * matches nothing. `.exact` lowercases the whole token and keeps edit distance.
 * The OR is parenthesized so it stays one clause when joined with AND.
 */
function camelFuzzyTerm(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("(") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'")
  ) {
    return undefined;
  }
  const split = splitFuzzyBoost(trimmed);
  const hasFuzzy = split.suffix.includes("~") || /[*?]/.test(split.core);
  if (!hasFuzzy || !/[a-z][A-Z]|[A-Za-z]\d|\d[A-Za-z]/.test(split.core)) {
    return undefined;
  }
  return escapeLuceneCore(split.core) + split.suffix;
}

function normalizeLuceneBody(body: string): string {
  if (/^https?:\/\//i.test(body)) {
    return normalizeLuceneValue(body, false);
  }
  const field = /^([A-Za-z_][\w.]*)\s*:(.*)$/s.exec(body);
  if (!field) {
    const fuzzy = camelFuzzyTerm(body);
    if (fuzzy) {
      const clause = EXACT_SUBFIELDS.map((name) => `${name}.exact:${fuzzy}`).join(" OR ");
      return `(${clause})`;
    }
    return normalizeLuceneValue(body, false);
  }
  const name = field[1] ?? "";
  const raw = field[2] ?? "";
  if (raw.startsWith("/")) {
    return normalizeLuceneValue(body, false);
  }
  const fuzzy = camelFuzzyTerm(raw);
  if (fuzzy && (EXACT_SUBFIELDS as readonly string[]).includes(name)) {
    return `${name}.exact:${fuzzy}`;
  }
  return `${name}:${normalizeLuceneValue(raw, CASEFOLD_FIELDS.has(name))}`;
}

function normalizeLuceneAtom(text: string): string {
  if (!text) {
    return text;
  }
  const prefixMatch = /^([+\-!]*)([\s\S]*)$/.exec(text);
  const prefix = prefixMatch?.[1] ?? "";
  const body = prefixMatch?.[2] ?? "";
  if (!body) {
    return text;
  }
  return prefix + normalizeLuceneBody(body);
}

function printNode(node: QueryNode): string {
  switch (node.kind) {
    case "atom":
      return normalizeLuceneAtom(node.text);
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
export function buildLuceneQueryBody(
  trimmedQuery: string,
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
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

  if (!usesNestedOrNegativeRouting && postPositive.length > 0) {
    return postTextQuery(postPositive, mode);
  }

  const must: ElasticsearchQuery[] = [];

  if (postPositive.length > 0) {
    must.push(postTextQuery(postPositive, mode));
  }

  for (const c of commentsPositive) {
    must.push(commentsClauseQuery(c, mode));
  }

  for (const c of votersPositive) {
    must.push(votersNested(c));
  }

  const must_not: ElasticsearchQuery[] = [];

  for (const c of postNegative) {
    must_not.push(postTextQuery([c], mode));
  }

  for (const c of commentsNegative) {
    must_not.push(commentsClauseQuery(c, mode));
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
