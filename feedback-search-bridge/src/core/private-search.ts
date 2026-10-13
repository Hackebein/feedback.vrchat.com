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
  /** Skip the board checkbox when counting the other boards. */
  ignoreBoard?: boolean;
  /** Skip one checkbox facet. Used for additional-hit (`+N`) counts. */
  ignoreRefinement?: string;
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

/**
 * Private-board matching. Exact substrings outrank camelCase splits, which
 * outrank a single edit on words of length >= 5. Lucene mode understands
 * AND/OR/NOT, quotes, and the fields the sidebar actually stores.
 */
function identifierParts(raw: string): string[] {
  const parts = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
  return parts.length > 1 ? parts : [];
}

function editDistanceAtMost1(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftLen = left.length;
  const rightLen = right.length;
  if (Math.abs(leftLen - rightLen) > 1) {
    return false;
  }
  if (leftLen === rightLen) {
    let first = -1;
    for (let index = 0; index < leftLen; index += 1) {
      if (left[index] === right[index]) {
        continue;
      }
      if (first === -1) {
        first = index;
        continue;
      }
      if (
        index === first + 1 &&
        left[index] === right[first] &&
        left[first] === right[index]
      ) {
        for (let rest = index + 1; rest < leftLen; rest += 1) {
          if (left[rest] !== right[rest]) {
            return false;
          }
        }
        return true;
      }
      return false;
    }
    return true;
  }
  const shorter = leftLen < rightLen ? left : right;
  const longer = leftLen < rightLen ? right : left;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) {
      return false;
    }
    skipped = true;
    longIndex += 1;
  }
  return true;
}

function fuzzyWord(hay: string, token: string): boolean {
  if (token.length < 5) {
    return false;
  }
  for (const word of hay.split(/[^a-z0-9]+/)) {
    if (word.length < 5 || word[0] !== token[0]) {
      continue;
    }
    if (Math.abs(word.length - token.length) > 1) {
      continue;
    }
    if (editDistanceAtMost1(word, token)) {
      return true;
    }
  }
  return false;
}

function countToken(hay: string, token: string): number {
  let score = 0;
  let from = 0;
  while (from < hay.length) {
    const at = hay.indexOf(token, from);
    if (at < 0) {
      break;
    }
    score += 1;
    from = at + token.length;
  }
  return score;
}

/** Exact substring outranks a camelCase split, which outranks one edit. */
function scoreToken(hay: string, raw: string): number {
  const token = raw.toLowerCase();
  if (!token) {
    return 0;
  }
  const exact = countToken(hay, token);
  if (exact > 0) {
    return 100 + exact;
  }
  const parts = identifierParts(raw);
  if (parts.length > 1 && parts.every((part) => hay.includes(part))) {
    return 40;
  }
  if (fuzzyWord(hay, token)) {
    return 5;
  }
  return 0;
}

function phraseMatches(hay: string, phrase: string): boolean {
  const words = phrase
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return true;
  }
  if (hay.includes(words.join(" "))) {
    return true;
  }
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]*");
  return new RegExp(pattern).test(hay);
}

function partitionQuotes(query: string): { phrases: string[]; terms: string } {
  const phrases: string[] = [];
  let terms = "";
  let index = 0;
  while (index < query.length) {
    const char = query[index] ?? "";
    if (char !== '"') {
      terms += char;
      index += 1;
      continue;
    }
    const end = query.indexOf('"', index + 1);
    const phrase = (end === -1 ? query.slice(index + 1) : query.slice(index + 1, end)).trim();
    if (phrase) {
      phrases.push(phrase);
    }
    terms += " ";
    index = end === -1 ? query.length : end + 1;
  }
  return { phrases, terms: terms.replace(/\s+/g, " ").trim() };
}

function scorePlain(text: string, query: string): number {
  const hay = text.toLowerCase();
  const { phrases, terms } = partitionQuotes(query);
  let score = 0;
  for (const phrase of phrases) {
    if (!phraseMatches(hay, phrase)) {
      return 0;
    }
    score += hay.includes(phrase.toLowerCase()) ? 120 : 40;
  }
  for (const raw of terms.split(/\s+/)) {
    if (!raw) {
      continue;
    }
    const part = scoreToken(hay, raw);
    if (part <= 0) {
      return 0;
    }
    score += part;
  }
  return score;
}

function matchesPlainQuery(text: string, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  return scorePlain(text, query) > 0;
}

const KEYWORD_FIELDS: ReadonlySet<string> = new Set(["status", "board.urlName"]);

type PrivateNode =
  | { op: "term"; field: string; value: string; phrase: boolean }
  | { op: "not"; child: PrivateNode }
  | { op: "and" | "or"; children: PrivateNode[] };

type PrivateTok =
  | { k: "and" | "or" | "not" | "lparen" | "rparen" }
  | { k: "term"; field: string; value: string; phrase: boolean };

function textsFor(post: Record<string, unknown>, field: string, combinedText: string): string[] {
  switch (field) {
    case "":
    case "combined_text":
      return [combinedText];
    case "title":
      return [readString(post.title)];
    case "details":
      return [readString(post.details)];
    case "author.name":
      return [readString(nestedRecord(post.author)?.name)];
    case "board.name":
      return [readString(nestedRecord(post.board)?.name)];
    case "board.urlName":
      return [readString(nestedRecord(post.board)?.urlName)];
    case "status":
      return [readString(post.status)];
    case "comments.value":
      return payloadComments(post).map((comment) => readString(comment.value));
    default:
      return [];
  }
}

function tokenizePrivate(input: string): PrivateTok[] {
  const tokens: PrivateTok[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (input.startsWith("&&", index)) {
      tokens.push({ k: "and" });
      index += 2;
      continue;
    }
    if (input.startsWith("||", index)) {
      tokens.push({ k: "or" });
      index += 2;
      continue;
    }
    const keyword = /^(AND|OR|NOT)\b/i.exec(input.slice(index));
    if (keyword) {
      const word = keyword[1]!.toLowerCase();
      if (word === "and" || word === "or" || word === "not") {
        tokens.push({ k: word });
      }
      index += keyword[1]!.length;
      continue;
    }
    if (char === "(") {
      tokens.push({ k: "lparen" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ k: "rparen" });
      index += 1;
      continue;
    }
    if (char === '"') {
      const end = input.indexOf('"', index + 1);
      tokens.push({
        k: "term",
        field: "",
        value: end === -1 ? input.slice(index + 1) : input.slice(index + 1, end),
        phrase: true,
      });
      index = end === -1 ? input.length : end + 1;
      continue;
    }
    let end = index;
    let atom = "";
    while (end < input.length) {
      const next = input[end] ?? "";
      if (/\s/.test(next) || next === "(" || next === ")") {
        break;
      }
      if (next === '"') {
        const quoteEnd = input.indexOf('"', end + 1);
        atom += input.slice(end, quoteEnd === -1 ? input.length : quoteEnd + 1);
        end = quoteEnd === -1 ? input.length : quoteEnd + 1;
        continue;
      }
      atom += next;
      end += 1;
    }
    if (/^https?:\/\//i.test(atom)) {
      tokens.push({ k: "term", field: "", value: atom, phrase: false });
    } else {
      const field = /^([A-Za-z_][\w.]*):(.*)$/.exec(atom);
      if (field) {
        let value = field[2] ?? "";
        let phrase = false;
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          phrase = true;
          value = value.slice(1, -1);
        }
        tokens.push({ k: "term", field: field[1] ?? "", value, phrase });
      } else if (atom) {
        tokens.push({ k: "term", field: "", value: atom, phrase: false });
      }
    }
    index = end > index ? end : index + 1;
  }
  return tokens;
}

function parsePrivateLucene(query: string): PrivateNode | undefined {
  const tokens = tokenizePrivate(query.trim());
  if (tokens.length === 0) {
    return undefined;
  }
  let index = 0;
  function peek(): PrivateTok | undefined {
    return tokens[index];
  }
  function parseOr(): PrivateNode {
    const children = [parseAnd()];
    while (peek()?.k === "or") {
      index += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0]! : { op: "or", children };
  }
  function parseAnd(): PrivateNode {
    const children = [parseNot()];
    while (true) {
      const next = peek();
      if (!next || next.k === "or" || next.k === "rparen") {
        break;
      }
      if (next.k === "and") {
        index += 1;
      }
      if (next.k === "and" || next.k === "term" || next.k === "not" || next.k === "lparen") {
        children.push(parseNot());
        continue;
      }
      break;
    }
    return children.length === 1 ? children[0]! : { op: "and", children };
  }
  function parseNot(): PrivateNode {
    if (peek()?.k === "not") {
      index += 1;
      return { op: "not", child: parseNot() };
    }
    return parsePrimary();
  }
  function parsePrimary(): PrivateNode {
    const token = peek();
    if (!token) {
      return { op: "term", field: "", value: "", phrase: false };
    }
    if (token.k === "lparen") {
      index += 1;
      const inner = parseOr();
      if (peek()?.k === "rparen") {
        index += 1;
      }
      return inner;
    }
    if (token.k === "term") {
      index += 1;
      return { op: "term", field: token.field, value: token.value, phrase: token.phrase };
    }
    index += 1;
    return { op: "term", field: "", value: "", phrase: false };
  }
  return parseOr();
}

function termMatches(
  post: Record<string, unknown>,
  field: string,
  value: string,
  phrase: boolean,
  combinedText: string,
): boolean {
  const texts = textsFor(post, field, combinedText);
  if (KEYWORD_FIELDS.has(field)) {
    const want = value.toLowerCase();
    return texts.some((text) => text.toLowerCase() === want);
  }
  if (phrase) {
    return texts.some((text) => phraseMatches(text.toLowerCase(), value));
  }
  return texts.some((text) => matchesPlainQuery(text, value));
}

function evalPrivate(post: Record<string, unknown>, node: PrivateNode, combinedText: string): boolean {
  switch (node.op) {
    case "not":
      return !evalPrivate(post, node.child, combinedText);
    case "and":
      return node.children.every((child) => evalPrivate(post, child, combinedText));
    case "or":
      return node.children.some((child) => evalPrivate(post, child, combinedText));
    case "term":
      return termMatches(post, node.field, node.value, node.phrase, combinedText);
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

function termScore(
  post: Record<string, unknown>,
  field: string,
  value: string,
  phrase: boolean,
  combinedText: string,
): number {
  if (!termMatches(post, field, value, phrase, combinedText)) {
    return 0;
  }
  if (KEYWORD_FIELDS.has(field)) {
    return 100;
  }
  const texts = textsFor(post, field, combinedText);
  let best = 0;
  for (const text of texts) {
    const score = phrase ? (phraseMatches(text.toLowerCase(), value) ? 120 : 0) : scorePlain(text, value);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

function scoreNode(post: Record<string, unknown>, node: PrivateNode, combinedText: string): number {
  switch (node.op) {
    case "not":
      return evalPrivate(post, node, combinedText) ? 1 : 0;
    case "and": {
      let total = 0;
      for (const child of node.children) {
        const score = scoreNode(post, child, combinedText);
        if (score <= 0) {
          return 0;
        }
        total += score;
      }
      return total;
    }
    case "or":
      return node.children.reduce(
        (best, child) => Math.max(best, scoreNode(post, child, combinedText)),
        0,
      );
    case "term":
      return termScore(post, node.field, node.value, node.phrase, combinedText);
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

export function privateMatchScore(post: Record<string, unknown>, query: string): number {
  return scorePrivate(post, query, buildCombinedText(post));
}

function scorePrivate(post: Record<string, unknown>, query: string, combinedText: string): number {
  const trimmed = query.trim();
  if (!trimmed) {
    return 0;
  }
  if (/[:"()]|\b(?:AND|OR|NOT)\b/.test(trimmed)) {
    const node = parsePrivateLucene(trimmed);
    if (!node) {
      return 0;
    }
    return scoreNode(post, node, combinedText);
  }
  return scorePlain(combinedText, trimmed);
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
  skipAttr: string | undefined,
): boolean {
  if (!filters) {
    return true;
  }
  for (const attr of REFINEMENT_ATTRS) {
    if (attr === skipAttr) {
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
  const query = readString(body.textSearch);
  const filters = options.luceneMode ? undefined : body.filters;
  const skipAttr =
    options.ignoreRefinement ?? (options.ignoreBoard ? "board_name" : undefined);
  return posts.filter((post) => {
    if (query.trim()) {
      if (options.luceneMode) {
        const node = parsePrivateLucene(query);
        if (!node || !evalPrivate(post.payload, node, post.combinedText)) {
          return false;
        }
      } else if (!matchesPlainQuery(post.combinedText, query)) {
        return false;
      }
    }
    return matchesFilters(post, filters, skipAttr);
  });
}

/**
 * Counts for unchecked values of each selected enum facet: posts that match
 * every other filter and do not already match a checked value of that facet.
 */
export function additionalFacetCounts(
  posts: StoredPrivatePost[],
  body: CannySearchBody,
  luceneMode: boolean,
): FacetCounts {
  if (luceneMode || !body.filters) {
    return {};
  }
  const out: FacetCounts = {};
  for (const attr of REFINEMENT_ATTRS) {
    const selected = body.filters.refinements[attr];
    if (!Array.isArray(selected) || selected.length === 0) {
      continue;
    }
    const selectedSet = new Set(selected);
    const bucket: Record<string, number> = {};
    for (const post of filterPrivatePosts(posts, body, {
      luceneMode: false,
      ignoreRefinement: attr,
    })) {
      const values = refinementValues(post.payload, attr);
      if (values.some((value) => selectedSet.has(value))) {
        continue;
      }
      const seen = new Set<string>();
      for (const value of values) {
        if (!value || seen.has(value)) {
          continue;
        }
        seen.add(value);
        bucket[value] = (bucket[value] ?? 0) + 1;
      }
    }
    if (Object.keys(bucket).length > 0) {
      out[attr] = bucket;
    }
  }
  return out;
}

function sortKey(
  post: Record<string, unknown>,
  sort: string,
  query: string,
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
      return scorePrivate(post, query, combinedText);
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
  const hasQuery = query.trim().length > 0;
  const resolved = sort.trim() || (hasQuery ? "relevance" : "newest");
  const asc = sortAscending(resolved, hasQuery);
  const decorated = hits.map((hit, index) => ({
    hit,
    index,
    key: sortKey(
      hit,
      resolved,
      query,
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
