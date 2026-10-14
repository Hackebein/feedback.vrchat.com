import type {
  ElasticsearchQuery,
  SearchAttribute,
  SearchSettingsConfig,
} from "searchkit";
import indexMappings from "../../deploy/opensearch/index_mappings.json" with { type: "json" };
import { ENGLISH_STOP } from "../../shared/english-stop";
import { splitSearchIdentifier } from "../../shared/identifier-split";
import { buildLuceneQueryBody } from "./lucene-query";
import { phraseAnalyzer, phraseSearchFields, type PhraseMode } from "./phrase-mode";

/** OpenSearch `terms.include` is anchored to the full bucket string. Searchkit's default regex prepends `([a-zA-Z]+ )+?` for queries longer than 2 chars, which never matches slug-like tokens without spaces. */
function slugSafeFacetQuery(
  field: string,
  size: number,
  search?: string,
): { terms: { field: string; size: number; include?: string } } {
  if (!search || search.length === 0) {
    return { terms: { field, size } };
  }
  const escaped = search.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
  const ci = escaped
    .split("")
    .map((c) =>
      /[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c,
    )
    .join("");
  return { terms: { field, size, include: `.*${ci}.*` } };
}

function fieldsWithBoost(attrs: SearchAttribute[], mult: number): string[] {
  return attrs.map((a) =>
    typeof a === "string"
      ? `${a}^${mult}`
      : `${a.field}^${(a.weight ?? 1) * mult}`,
  );
}

export const textSearchAttributes: SearchAttribute[] = [
  { field: "combined_text", weight: 3 },
  { field: "title", weight: 2 },
  { field: "author.name", weight: 1 },
  "details",
];

/**
 * Exact identifier hits sit on a constant-score band above every other hit.
 * Adjacent split parts sit on a lower constant-score band, still above the
 * fuzzy band, so prose “group id” outranks a one-edit typo such as `gropIds`.
 * Fuzzy edit distance is 1 only for terms of length >= 5 (`AUTO:5,100` is 0
 * below 5, 1 until 100) and only against the unstemmed `.exact` subfield.
 * `AUTO` after the English stemmer is what made `groupIds` (stem `groupid`)
 * match every post whose stem is `group`.
 *
 * Unquoted words the user typed are a bag of single terms. A phrase on the
 * whole string changed scores with word order (`full body` ranked the in-order
 * post above `body full`). `synonym_graph` only expands a multi-word synonym
 * in the listed order, so those phrases are planned as the same bag. One
 * camelCase or letter/number token (`groupIds`, `SDK3`) stays one identifier:
 * the whole token matches on `.exact`, and the split parts have to be adjacent
 * in either order. That identifier does not match the same words in different
 * sentences. Separate words such as `group ids` still do. A stop word inside
 * the identifier (`endOfLine`) is kept on `.phrase`, so “end of line” matches
 * and a different word in that hole (“end foo line”) does not. Adjacent
 * content parts (“end line”) still match. If the split
 * parts are a `feedback_synonyms` phrase in any order, the single-token
 * synonyms match too (`fullBodyTracking` matches `fbt`) on the adjacent band.
 * That expansion does not take the exact band, so a literal `fbt` post stays
 * below the adjacent phrase. Quoted phrases stay
 * ordered and use the `text_phrase` analyzer on `.phrase` (stem, keep stop
 * words, no synonyms). English stop words are dropped before an unquoted term
 * is required. A query that is only stop words is `match_all`: nothing remains
 * to rank.
 *
 * Several casings of one word can preserve case (`aBc` and `AbC` split
 * differently). The lexicographically smallest casing wins, so swapping
 * unquoted terms cannot change the identifier that is searched.
 *
 * Rewritten clause count stays under OpenSearch's default `max_clause_count`
 * of 1024. The count is the leaf walk of the query that was built: one leaf
 * per interval match on each field (the scoring proximity copy is a second
 * walk), `max_expansions` leaves per fuzzy field, and synonym expansions from
 * the search analyzer. Fuzzy words share {@link FUZZY_CLAUSE_BUDGET}, 256
 * under 1024. A normal 5–10 word query keeps a fuzzy band on every eligible
 * word; `max_expansions` shrinks before any fuzzy band is removed. The
 * scoring proximity copy and fuzzy bands are dropped before a typed term is.
 * Distinct terms the user typed are kept until that is not enough. Repeated
 * copies collapse to one AND clause. Removed terms come back as
 * `omittedTerms`, shortest first. An identifier with more than 8 parts is
 * one token, so a long camelCase string cannot build a giant intervals query.
 * A search that still returns `too_many_nested_clauses` is retried once
 * without the scoring proximity copy or fuzzy bands.
 */
const EXACT_BAND_BOOST = 1000;
const ADJACENT_BAND_BOOST = 50;
const FUZZY_BAND_BOOST = 5;

const MAX_FUZZY_EXPANSIONS = 50;
/** Below this, a fuzzy band is turned off and the remaining words keep the clauses. */
const MIN_FUZZY_EXPANSIONS = 8;
/** OpenSearch `indices.query.bool.max_clause_count`. */
export const OPENSEARCH_MAX_CLAUSE_COUNT = 1024;
/**
 * Headroom under {@link OPENSEARCH_MAX_CLAUSE_COUNT}. Five saturated terms at
 * 50 expansions already sit at about 1040 once every `.exact` field is filled.
 */
export const FUZZY_CLAUSE_MARGIN = 256;
/** Shared by every fuzzy word before the built query is counted. */
export const FUZZY_CLAUSE_BUDGET = OPENSEARCH_MAX_CLAUSE_COUNT - FUZZY_CLAUSE_MARGIN;
/** Exact band and analyzed best_fields band, one clause per searched field. */
const BANDS_PER_FIELD = 2;
const MAX_PHRASES = 16;
const MAX_IDENTIFIER_PARTS = 8;

/** `AUTO:5,100` is edit distance 2 at length >= 100, which is the expensive automaton. */
function fuzzyEligible(term: string): boolean {
  return term.length >= 5 && term.length < 100;
}

/** Plain-query rewrite budget, under OpenSearch's 1024 clause limit. */
export const PLAIN_CLAUSE_BUDGET = 960;

/** CamelCase and letter/number boundaries have to reach the search analyzer intact. Lowercasing first hides the split. */
function preservesCase(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || /[A-Za-z]\d|\d[A-Za-z]/.test(token);
}

/** Smallest case-preserving spelling wins so input order cannot change the split. */
function preferredSpelling(current: string | undefined, token: string): string {
  const folded = token.toLowerCase();
  if (!preservesCase(token)) {
    return current ?? folded;
  }
  if (!current || !preservesCase(current) || token < current) {
    return token;
  }
  return current;
}

type SynonymGroup = { singles: string[]; phrases: string[][] };

function readSynonymLines(mapping: unknown): string[] {
  if (!mapping || typeof mapping !== "object") {
    throw new Error("index mapping is missing feedback_synonyms");
  }
  const lines = (
    mapping as {
      settings?: {
        analysis?: { filter?: { feedback_synonyms?: { synonyms?: unknown } } };
      };
    }
  ).settings?.analysis?.filter?.feedback_synonyms?.synonyms;
  if (!Array.isArray(lines) || lines.some((line) => typeof line !== "string")) {
    throw new Error("index mapping is missing feedback_synonyms");
  }
  return lines;
}

function parseSynonymLine(line: string): SynonymGroup {
  const singles: string[] = [];
  const phrases: string[][] = [];
  for (const part of line.split(",")) {
    const tokens = part
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length === 1) {
      singles.push(tokens[0]!);
    } else if (tokens.length > 1) {
      phrases.push(tokens);
    }
  }
  return { singles, phrases };
}

const SYNONYM_LINES = readSynonymLines(indexMappings)
  .map(parseSynonymLine)
  .filter((group) => group.singles.length > 0);
const SYNONYM_GROUPS = SYNONYM_LINES.filter((group) => group.phrases.length > 0);

type SynonymExpansion = { singles: readonly string[]; phrases: readonly string[][]; tokens: readonly string[] };

const SYNONYM_BY_SINGLE = new Map<string, SynonymExpansion>();
for (const group of SYNONYM_LINES) {
  const tokens = new Set<string>(group.singles);
  for (const phrase of group.phrases) {
    for (const token of phrase) {
      tokens.add(token);
    }
  }
  const expansion: SynonymExpansion = { singles: group.singles, phrases: group.phrases, tokens: [...tokens] };
  for (const single of group.singles) {
    SYNONYM_BY_SINGLE.set(single, expansion);
  }
}

function sameTokens(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  const a = left.map((token) => token.toLowerCase()).sort();
  const b = right.map((token) => token.toLowerCase()).sort();
  return a.every((token, index) => token === b[index]);
}

/** Split parts that are a synonym phrase, in any order, expand to that group's single tokens. */
function synonymSingles(parts: readonly string[]): string[] {
  if (parts.length < 2) {
    return [];
  }
  const singles = new Set<string>();
  for (const group of SYNONYM_GROUPS) {
    if (!group.phrases.some((phrase) => sameTokens(phrase, parts))) {
      continue;
    }
    for (const single of group.singles) {
      singles.add(single);
    }
  }
  return [...singles].sort();
}

function tokenCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function covers(available: ReadonlyMap<string, number>, tokens: readonly string[]): boolean {
  const need = tokenCounts(tokens);
  for (const [token, count] of need) {
    if ((available.get(token) ?? 0) < count) {
      return false;
    }
  }
  return true;
}

function consume(available: Map<string, number>, tokens: readonly string[]): void {
  for (const token of tokens) {
    const left = (available.get(token) ?? 0) - 1;
    if (left <= 0) {
      available.delete(token);
    } else {
      available.set(token, left);
    }
  }
}

function exactFields(attrs: SearchAttribute[]): string[] {
  return attrs.map((attribute) =>
    typeof attribute === "string" ? `${attribute}.exact` : `${attribute.field}.exact`,
  );
}

/** Pull `"..."` phrases out so plain search can require them in order. */
export function partitionPlainQuery(query: string): { phrases: string[]; terms: string } {
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

function bestFields(
  query: string,
  fields: string[],
  fuzziness: 0 | "AUTO:5,100",
  maxExpansions = MAX_FUZZY_EXPANSIONS,
): ElasticsearchQuery {
  return {
    multi_match: {
      query,
      fields,
      type: "best_fields",
      operator: "and",
      fuzziness,
      auto_generate_synonyms_phrase_query: false,
      ...(fuzziness === 0
        ? {}
        : { prefix_length: 1, max_expansions: maxExpansions, fuzzy_transpositions: true }),
    },
  };
}

function scoreBand(
  query: string,
  fields: string[],
  fuzziness: 0 | "AUTO:5,100",
  boost: number,
  maxExpansions = MAX_FUZZY_EXPANSIONS,
): ElasticsearchQuery {
  return {
    constant_score: {
      boost,
      filter: bestFields(query, fields, fuzziness, maxExpansions),
    },
  };
}

function phraseQuery(
  phrase: string,
  fields: string[],
  mode: PhraseMode,
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

function termClause(
  term: string,
  searchAttributes: SearchAttribute[],
  maxExpansions: number,
): ElasticsearchQuery {
  const should: ElasticsearchQuery[] = [
    scoreBand(term, exactFields(searchAttributes), 0, EXACT_BAND_BOOST),
    bestFields(term, fieldsWithBoost(searchAttributes, 1), 0),
  ];
  if (maxExpansions > 0 && fuzzyEligible(term)) {
    should.push(
      scoreBand(term, exactFields(searchAttributes), "AUTO:5,100", FUZZY_BAND_BOOST, maxExpansions),
    );
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/**
 * A synonym single reached by expanding one identifier (`fullBodyTracking` or
 * `trackingBodyFull` → `fbt`) shares the adjacent band. `termClause` would put
 * the literal synonym on the exact band and above the adjacent phrase.
 */
function identifierSynonymClause(
  term: string,
  searchAttributes: SearchAttribute[],
): ElasticsearchQuery {
  const fields = fieldsWithBoost(searchAttributes, 1);
  return {
    bool: {
      should: [
        scoreBand(term, fields, 0, ADJACENT_BAND_BOOST),
        bestFields(term, fields, 0),
      ],
      minimum_should_match: 1,
    },
  };
}

function attributeField(attribute: SearchAttribute): { field: string; weight: number } {
  if (typeof attribute === "string") {
    return { field: attribute, weight: 1 };
  }
  return { field: attribute.field, weight: attribute.weight ?? 1 };
}

function intervalGroup(
  field: string,
  parts: readonly string[],
  weight: number,
): ElasticsearchQuery {
  return {
    intervals: {
      [field]: {
        all_of: {
          ordered: false,
          max_gaps: 0,
          intervals: parts.map((part) => ({ match: { query: part } })),
        },
        boost: weight,
      },
    },
  } as ElasticsearchQuery;
}

/**
 * Content parts are adjacent on the search field (`max_gaps` 0). Stop words
 * inside the identifier are matched on `.phrase`, which still indexes them,
 * so the hole they leave is that word and not an extra token.
 */
function proximityQuery(
  parts: readonly string[],
  phraseParts: readonly string[],
  searchAttributes: SearchAttribute[],
): ElasticsearchQuery {
  const should: ElasticsearchQuery[] = [];
  for (const attribute of searchAttributes) {
    const { field, weight } = attributeField(attribute);
    if (parts.length >= 2) {
      should.push(intervalGroup(field, parts, weight));
    }
    if (phraseParts.length >= 2) {
      should.push(intervalGroup(`${field}.phrase`, phraseParts, weight));
    }
  }
  return { bool: { should, minimum_should_match: 1 } };
}

/**
 * Exact band, then the adjacent-split band, then the fuzzy band. Split parts
 * cannot come from different sentences.
 */
function identifierClause(
  term: string,
  parts: readonly string[],
  phraseParts: readonly string[],
  searchAttributes: SearchAttribute[],
  maxExpansions: number,
  scoreProximity: boolean,
): ElasticsearchQuery {
  const should: ElasticsearchQuery[] = [
    scoreBand(term, exactFields(searchAttributes), 0, EXACT_BAND_BOOST),
  ];
  if (parts.length >= 2 || phraseParts.length >= 2) {
    const proximity = proximityQuery(parts, phraseParts, searchAttributes);
    should.push({
      constant_score: {
        boost: ADJACENT_BAND_BOOST,
        filter: proximity,
      },
    });
    if (scoreProximity) {
      should.push(proximity);
    }
  } else if (parts.length === 1) {
    should.push(bestFields(parts[0]!, fieldsWithBoost(searchAttributes, 1), 0));
  }
  if (maxExpansions > 0 && fuzzyEligible(term)) {
    should.push(
      scoreBand(term, exactFields(searchAttributes), "AUTO:5,100", FUZZY_BAND_BOOST, maxExpansions),
    );
  }
  return { bool: { should, minimum_should_match: 1 } };
}

type TermPlan =
  | { kind: "synonym"; words: string[]; singles: string[] }
  | { kind: "term"; term: string }
  | { kind: "identifier"; term: string; parts: string[]; phraseParts: string[]; singles: string[] };

/**
 * Multi-word synonym phrases are taken from the token bag in any order.
 * Leftover copies of that group's single-token synonyms join the same OR,
 * so `fbt full body tracking` still matches a post that only has one form.
 */
function planUnquotedTerms(terms: string): TermPlan[] {
  const spellings = new Map<string, string>();
  const tokens: string[] = [];
  for (const token of terms.split(/\s+/)) {
    if (!token) {
      continue;
    }
    const key = token.toLowerCase();
    if (ENGLISH_STOP.has(key)) {
      continue;
    }
    tokens.push(key);
    spellings.set(key, preferredSpelling(spellings.get(key), token));
  }
  const available = tokenCounts(tokens);
  const candidates: Array<{ words: string[]; singles: string[] }> = [];
  for (const group of SYNONYM_GROUPS) {
    for (const phrase of group.phrases) {
      if (covers(available, phrase)) {
        candidates.push({ words: phrase, singles: group.singles });
      }
    }
  }
  candidates.sort((left, right) => {
    if (right.words.length !== left.words.length) {
      return right.words.length - left.words.length;
    }
    const leftText = left.words.join(" ");
    const rightText = right.words.join(" ");
    if (leftText < rightText) return -1;
    if (leftText > rightText) return 1;
    return 0;
  });
  const selected: Array<{ words: string[]; singles: string[] }> = [];
  for (const candidate of candidates) {
    if (!covers(available, candidate.words)) {
      continue;
    }
    consume(available, candidate.words);
    for (const single of candidate.singles) {
      available.delete(single);
    }
    selected.push(candidate);
  }
  selected.sort((left, right) => {
    const leftText = left.words.join(" ");
    const rightText = right.words.join(" ");
    if (leftText < rightText) return -1;
    if (leftText > rightText) return 1;
    return 0;
  });
  const plans: TermPlan[] = selected.map((group) => ({
    kind: "synonym",
    words: group.words,
    singles: group.singles,
  }));
  for (const term of [...available.keys()].sort()) {
    const count = available.get(term) ?? 0;
    const text = spellings.get(term) ?? term;
    for (let index = 0; index < count; index += 1) {
      if (preservesCase(text)) {
        const split = splitSearchIdentifier(text);
        if (
          split.parts.length > MAX_IDENTIFIER_PARTS ||
          split.phraseParts.length > MAX_IDENTIFIER_PARTS
        ) {
          plans.push({ kind: "term", term: text });
        } else {
          plans.push({
            kind: "identifier",
            term: text,
            parts: split.parts,
            phraseParts: split.phraseParts,
            singles: synonymSingles(split.parts),
          });
        }
      } else {
        plans.push({ kind: "term", term: text });
      }
    }
  }
  return plans;
}

function planClause(
  plan: TermPlan,
  searchAttributes: SearchAttribute[],
  fuzzyWords: number,
  maxExpansions: number,
  scoreProximity: boolean,
): ElasticsearchQuery {
  switch (plan.kind) {
    case "term":
      return termClause(plan.term, searchAttributes, fuzzyWords > 0 ? maxExpansions : 0);
    case "identifier": {
      const identifier = identifierClause(
        plan.term,
        plan.parts,
        plan.phraseParts,
        searchAttributes,
        fuzzyWords > 0 ? maxExpansions : 0,
        scoreProximity,
      );
      if (plan.singles.length === 0) {
        return identifier;
      }
      return {
        bool: {
          should: [
            identifier,
            ...plan.singles.map((single) => identifierSynonymClause(single, searchAttributes)),
          ],
          minimum_should_match: 1,
        },
      };
    }
    case "synonym": {
      const eligible = [...plan.words, ...plan.singles]
        .filter((word) => fuzzyEligible(word))
        .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
      const fuzzySet = new Set(eligible.slice(0, fuzzyWords));
      const clauseFor = (word: string): ElasticsearchQuery =>
        termClause(word, searchAttributes, fuzzySet.has(word) ? maxExpansions : 0);
      return {
        bool: {
          should: [
            { bool: { must: plan.words.map((word) => clauseFor(word)) } },
            ...plan.singles.map((single) => clauseFor(single)),
          ],
          minimum_should_match: 1,
        },
      };
    }
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function fuzzyUnits(plan: TermPlan): number {
  switch (plan.kind) {
    case "term":
      return fuzzyEligible(plan.term) ? 1 : 0;
    case "identifier":
      return fuzzyEligible(plan.term) ? 1 : 0;
    case "synonym":
      return [...plan.words, ...plan.singles].filter((word) => fuzzyEligible(word)).length;
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function hasProximity(plan: TermPlan): boolean {
  return plan.kind === "identifier" && (plan.parts.length >= 2 || plan.phraseParts.length >= 2);
}

function planKey(plan: TermPlan): string {
  switch (plan.kind) {
    case "term":
      return `term:${plan.term.toLowerCase()}`;
    case "identifier":
      return `id:${plan.term.toLowerCase()}`;
    case "synonym":
      return `syn:${plan.words.join(" ")}:${plan.singles.join(" ")}`;
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function collapsePlans(plans: readonly TermPlan[]): TermPlan[] {
  const seen = new Set<string>();
  const kept: TermPlan[] = [];
  for (const plan of plans) {
    const key = planKey(plan);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(plan);
  }
  return kept;
}

function planTerms(plan: TermPlan): string[] {
  switch (plan.kind) {
    case "term":
    case "identifier":
      return [plan.term];
    case "synonym":
      return [...plan.words, ...plan.singles];
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

function representative(plan: TermPlan): string {
  return (planTerms(plan)[0] ?? "").toLowerCase();
}

/** Shortest terms go first. Equal length drops the higher trailing number, then the later spelling. */
function dropBefore(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return left.length < right.length;
  }
  const leftNumber = /(\d+)$/.exec(left);
  const rightNumber = /(\d+)$/.exec(right);
  if (leftNumber && rightNumber && leftNumber[1] !== rightNumber[1]) {
    return Number(leftNumber[1]) > Number(rightNumber[1]);
  }
  return left > right;
}

type BudgetTerm = { plan: TermPlan; fuzzyWords: number; scoreProximity: boolean };

function fuzzyWordCount(planned: readonly BudgetTerm[]): number {
  let words = 0;
  for (const item of planned) {
    words += Math.min(item.fuzzyWords, fuzzyUnits(item.plan));
  }
  return words;
}

function expansionFor(words: number, fieldCount: number): number {
  if (words <= 0 || fieldCount <= 0) {
    return 0;
  }
  const perWord = Math.floor(FUZZY_CLAUSE_BUDGET / words);
  const expansions = Math.floor(perWord / fieldCount) - BANDS_PER_FIELD;
  if (expansions <= 0) {
    return 0;
  }
  return Math.min(MAX_FUZZY_EXPANSIONS, expansions);
}

/** `max_expansions` for `words` fuzzy terms on `searchAttributes`, before any band is removed. */
export function fuzzyExpansionLimit(
  words: number,
  searchAttributes: SearchAttribute[] = textSearchAttributes,
): number {
  return expansionFor(words, exactFields(searchAttributes).length);
}

function fieldBase(field: string): string {
  const boost = field.lastIndexOf("^");
  return boost === -1 ? field : field.slice(0, boost);
}

function fieldKind(field: string): "exact" | "phrase" | "search" {
  const name = fieldBase(field);
  if (name.endsWith(".exact")) {
    return "exact";
  }
  if (name.endsWith(".phrase")) {
    return "phrase";
  }
  return "search";
}

/** Analyzed best_fields leaf count for one token. Phrase synonyms become one term per token. */
function analyzedTokenLeaves(token: string): number {
  const expansion = SYNONYM_BY_SINGLE.get(token.toLowerCase());
  if (!expansion || expansion.phrases.length === 0) {
    return 1;
  }
  let leaves = expansion.singles.length;
  for (const phrase of expansion.phrases) {
    leaves += phrase.length;
  }
  return leaves;
}

function analyzedTextLeaves(text: string): number {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return 1;
  }
  let leaves = 0;
  for (const token of tokens) {
    leaves += analyzedTokenLeaves(token);
  }
  return leaves;
}

function plainTokenLeaves(text: string): number {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  return Math.max(1, tokens.length);
}

function multiMatchLeaves(body: Record<string, unknown>): number {
  const fields = Array.isArray(body.fields) ? body.fields.map((field) => String(field)) : [];
  const query = typeof body.query === "string" ? body.query : "";
  const type = typeof body.type === "string" ? body.type : "best_fields";
  if (type === "phrase" || type === "phrase_prefix") {
    return fields.length;
  }
  const fuzziness = body.fuzziness;
  const fuzzy = fuzziness !== undefined && fuzziness !== 0 && fuzziness !== "0";
  if (fuzzy) {
    const expansions =
      typeof body.max_expansions === "number" ? body.max_expansions : MAX_FUZZY_EXPANSIONS;
    return fields.length * expansions;
  }
  let leaves = 0;
  for (const field of fields) {
    leaves += fieldTextLeaves(field, query);
  }
  return leaves;
}

function fieldTextLeaves(field: string, query: string): number {
  const kind = fieldKind(field);
  switch (kind) {
    case "exact":
    case "phrase":
      return plainTokenLeaves(query);
    case "search":
      return analyzedTextLeaves(query);
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function intervalMatchLeaves(field: string, query: string): number {
  const kind = fieldKind(field);
  switch (kind) {
    case "exact":
    case "phrase":
      return plainTokenLeaves(query);
    case "search": {
      const expansion = SYNONYM_BY_SINGLE.get(query.trim().toLowerCase());
      return expansion ? expansion.tokens.length : plainTokenLeaves(query);
    }
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function intervalSourceLeaves(source: unknown, field: string): number {
  if (!source || typeof source !== "object") {
    return 0;
  }
  const record = source as Record<string, unknown>;
  const match = record.match;
  if (match && typeof match === "object") {
    const query = (match as { query?: unknown }).query;
    return typeof query === "string" ? intervalMatchLeaves(field, query) : 1;
  }
  const allOf = record.all_of;
  if (allOf && typeof allOf === "object") {
    return intervalListLeaves((allOf as { intervals?: unknown }).intervals, field);
  }
  const anyOf = record.any_of;
  if (anyOf && typeof anyOf === "object") {
    return intervalListLeaves((anyOf as { intervals?: unknown }).intervals, field);
  }
  return 0;
}

function intervalListLeaves(intervals: unknown, field: string): number {
  if (!Array.isArray(intervals)) {
    return 0;
  }
  let leaves = 0;
  for (const interval of intervals) {
    leaves += intervalSourceLeaves(interval, field);
  }
  return leaves;
}

function intervalsLeaves(body: Record<string, unknown>): number {
  let leaves = 0;
  for (const [field, spec] of Object.entries(body)) {
    leaves += intervalSourceLeaves(spec, field);
  }
  return leaves;
}

function clauseList(value: unknown): unknown[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** One leaf per query Lucene's `IndexSearcher` clause visitor counts. */
function countNestedClauses(query: unknown): number {
  if (!query || typeof query !== "object") {
    return 0;
  }
  if (Array.isArray(query)) {
    let leaves = 0;
    for (const item of query) {
      leaves += countNestedClauses(item);
    }
    return leaves;
  }
  const record = query as Record<string, unknown>;
  if ("match_all" in record || "match_none" in record) {
    return 1;
  }
  if ("term" in record || "terms" in record) {
    return 1;
  }
  if (record.multi_match && typeof record.multi_match === "object") {
    return multiMatchLeaves(record.multi_match as Record<string, unknown>);
  }
  if (record.intervals && typeof record.intervals === "object") {
    return intervalsLeaves(record.intervals as Record<string, unknown>);
  }
  if (record.constant_score && typeof record.constant_score === "object") {
    return countNestedClauses((record.constant_score as { filter?: unknown }).filter);
  }
  if (record.dis_max && typeof record.dis_max === "object") {
    return countNestedClauses((record.dis_max as { queries?: unknown }).queries);
  }
  if (record.bool && typeof record.bool === "object") {
    const body = record.bool as Record<string, unknown>;
    return (
      countNestedClauses(clauseList(body.must)) +
      countNestedClauses(clauseList(body.filter)) +
      countNestedClauses(clauseList(body.should)) +
      countNestedClauses(clauseList(body.must_not))
    );
  }
  return 0;
}

function dropIndex(planned: readonly BudgetTerm[], onlyProximity: boolean): number {
  let index = -1;
  for (let cursor = 0; cursor < planned.length; cursor += 1) {
    const item = planned[cursor];
    if (!item || (onlyProximity && !hasProximity(item.plan))) {
      continue;
    }
    if (index < 0 || dropBefore(representative(item.plan), representative(planned[index]!.plan))) {
      index = cursor;
    }
  }
  return index;
}

function shedFuzzy(planned: BudgetTerm[]): boolean {
  const index = dropIndex(
    planned.filter((item) => item.fuzzyWords > 0),
    false,
  );
  if (index < 0) {
    return false;
  }
  const victim = planned.filter((item) => item.fuzzyWords > 0)[index];
  if (!victim) {
    return false;
  }
  const at = planned.indexOf(victim);
  if (at < 0) {
    return false;
  }
  planned[at] = { ...victim, fuzzyWords: victim.fuzzyWords - 1 };
  return true;
}

function assemblePlain(
  planned: readonly BudgetTerm[],
  phrases: readonly string[],
  maxExpansions: number,
  searchAttributes: SearchAttribute[],
  mode: PhraseMode,
): ElasticsearchQuery {
  const phraseFields = fieldsWithBoost(searchAttributes, 2);
  const must: ElasticsearchQuery[] = phrases.map((phrase) => phraseQuery(phrase, phraseFields, mode));
  for (const item of planned) {
    must.push(
      planClause(item.plan, searchAttributes, item.fuzzyWords, maxExpansions, item.scoreProximity),
    );
  }
  if (must.length === 0) {
    return { match_all: {} };
  }
  return { bool: { must } };
}

function cappedExpansions(planned: readonly BudgetTerm[], fieldCount: number): number {
  const expansions = expansionFor(fuzzyWordCount(planned), fieldCount);
  return expansions < MIN_FUZZY_EXPANSIONS ? 0 : expansions;
}

function trimPlain(
  plans: readonly TermPlan[],
  phraseList: readonly string[],
  searchAttributes: SearchAttribute[],
  mode: PhraseMode,
  degraded: boolean,
): { planned: BudgetTerm[]; phrases: string[]; omittedTerms: string[]; maxExpansions: number } {
  const fieldCount = exactFields(searchAttributes).length;
  let planned: BudgetTerm[] = collapsePlans(plans).map((plan) => ({
    plan,
    fuzzyWords: 0,
    scoreProximity: !degraded && hasProximity(plan),
  }));
  const omitted: string[] = [];
  const omitAt = (index: number): void => {
    const item = planned[index];
    if (!item) {
      return;
    }
    omitted.push(...planTerms(item.plan));
    planned = planned.filter((_, itemIndex) => itemIndex !== index);
  };

  if (!degraded) {
    planned = planned.map((item) => ({ ...item, fuzzyWords: fuzzyUnits(item.plan) }));
  }
  let maxExpansions = degraded ? 0 : cappedExpansions(planned, fieldCount);
  while (!degraded && maxExpansions < MIN_FUZZY_EXPANSIONS && shedFuzzy(planned)) {
    maxExpansions = expansionFor(fuzzyWordCount(planned), fieldCount);
  }
  if (maxExpansions < MIN_FUZZY_EXPANSIONS) {
    maxExpansions = 0;
    planned = planned.map((item) => ({ ...item, fuzzyWords: 0 }));
  }

  let phrases = phraseList.slice(0, MAX_PHRASES);
  for (const phrase of phraseList.slice(MAX_PHRASES)) {
    omitted.push(`"${phrase}"`);
  }
  const overBudget = (): boolean =>
    countNestedClauses(assemblePlain(planned, phrases, maxExpansions, searchAttributes, mode)) >
    PLAIN_CLAUSE_BUDGET;
  while (overBudget() && planned.length > 1) {
    if (planned.some((item) => item.scoreProximity)) {
      planned = planned.map((item) => ({ ...item, scoreProximity: false }));
      continue;
    }
    if (fuzzyWordCount(planned) > 0) {
      if (!shedFuzzy(planned)) {
        break;
      }
      maxExpansions = cappedExpansions(planned, fieldCount);
      if (maxExpansions === 0) {
        planned = planned.map((item) => ({ ...item, fuzzyWords: 0 }));
      }
      continue;
    }
    const index = dropIndex(planned, false);
    if (index < 0) {
      break;
    }
    omitAt(index);
  }
  while (overBudget() && phrases.length > 0) {
    const phrase = phrases[phrases.length - 1];
    phrases = phrases.slice(0, -1);
    if (phrase) {
      omitted.push(`"${phrase}"`);
    }
  }
  return { planned, phrases, omittedTerms: omitted, maxExpansions };
}

type CompiledPlainQuery = {
  query: ElasticsearchQuery;
  clauses: number;
  omittedTerms: string[];
  expansionSlots: number;
};

function compilePlainQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  mode: PhraseMode,
  degraded = false,
): CompiledPlainQuery {
  const q = query.trim();
  if (!q) {
    return { query: { match_all: {} }, clauses: 1, omittedTerms: [], expansionSlots: 0 };
  }
  const { phrases, terms } = partitionPlainQuery(q);
  const trimmed = trimPlain(
    terms ? planUnquotedTerms(terms) : [],
    phrases,
    searchAttributes,
    mode,
    degraded,
  );
  const built = assemblePlain(
    trimmed.planned,
    trimmed.phrases,
    trimmed.maxExpansions,
    searchAttributes,
    mode,
  );
  return {
    query: built,
    clauses: countNestedClauses(built),
    omittedTerms: trimmed.omittedTerms,
    expansionSlots: fuzzyWordCount(trimmed.planned) * trimmed.maxExpansions,
  };
}

export function instantSearchStrictQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  _config?: SearchSettingsConfig,
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
  return compilePlainQuery(query, searchAttributes, mode).query;
}

/** Same plain query with the scoring proximity copy and fuzzy bands removed. */
export function degradedPlainQuery(
  query: string,
  searchAttributes: SearchAttribute[] = textSearchAttributes,
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
  return compilePlainQuery(query, searchAttributes, mode, true).query;
}

export function isTooManyNestedClauses(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("too_many_nested_clauses");
  }
  if (value instanceof Error) {
    return isTooManyNestedClauses(value.message);
  }
  if (Array.isArray(value)) {
    return value.some((item) => isTooManyNestedClauses(item));
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).includes("too_many_nested_clauses");
    } catch {
      return false;
    }
  }
  return false;
}

/** Searchkit runs this before it rewrites a nested-clause failure into a generic transform error. */
export async function rejectTooManyNestedClauses<T>(responses: readonly T[]): Promise<T[]> {
  if (responses.some((response) => isTooManyNestedClauses(response))) {
    throw new Error("too_many_nested_clauses");
  }
  return [...responses];
}

/** One retry. Lucene queries are not rebuilt as a degraded plain query. */
export async function retryWithoutNestedClauses<T>(
  lucene: boolean,
  run: (degraded: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await run(false);
  } catch (error) {
    if (lucene || !isTooManyNestedClauses(error)) {
      throw error;
    }
    return run(true);
  }
}

/** Rewritten clause estimate for a plain query, after the budget trim. */
export function plainQueryClauseEstimate(
  query: string,
  searchAttributes: SearchAttribute[] = textSearchAttributes,
): number {
  return compilePlainQuery(query, searchAttributes, "strict").clauses;
}

export type PlainQueryLimit = {
  /** Terms removed so the rewrite stays under the clause budget. Empty when every distinct term is kept. */
  omittedTerms: string[];
  clauses: number;
  expansionSlots: number;
};

/** What the plain-query budget did to `query`, including terms that could not be kept. */
export function plainQueryLimit(
  query: string,
  searchAttributes: SearchAttribute[] = textSearchAttributes,
  degraded = false,
): PlainQueryLimit {
  const compiled = compilePlainQuery(query, searchAttributes, "strict", degraded);
  return {
    omittedTerms: compiled.omittedTerms,
    clauses: compiled.clauses,
    expansionSlots: compiled.expansionSlots,
  };
}

/** Stamp `omittedTerms` onto each InstantSearch result. Lucene queries are not trimmed this way. */
export function withOmittedTerms(
  body: unknown,
  queries: readonly string[],
  lucene: boolean,
  degraded = false,
): unknown {
  if (!body || typeof body !== "object" || !Array.isArray((body as { results?: unknown }).results)) {
    return body;
  }
  const record = body as { results: unknown[] };
  return {
    ...record,
    results: record.results.map((result, index) => {
      if (!result || typeof result !== "object") {
        return result;
      }
      const omittedTerms = lucene
        ? []
        : plainQueryLimit(queries[index] ?? "", textSearchAttributes, degraded).omittedTerms;
      return { ...(result as Record<string, unknown>), omittedTerms };
    }),
  };
}

export function gatewayEnv(): {
  opensearchUrl: string;
  opensearchUser: string;
  opensearchPassword: string;
  bind: string;
  port: number;
} {
  const opensearchUrl =
    process.env.OPENSEARCH_URL?.trim() || "http://127.0.0.1:9200";
  const opensearchUser = process.env.OPENSEARCH_USER?.trim();
  const opensearchPassword = process.env.OPENSEARCH_PASSWORD?.trim();
  if (!opensearchUser || !opensearchPassword) {
    throw new Error(
      "Configure OPENSEARCH_USER and OPENSEARCH_PASSWORD via gateway EnvironmentFile (/etc/feedback-search/gateway.env).",
    );
  }
  const bind = process.env.GATEWAY_BIND?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.PORT || "3333", 10);
  if (Number.isNaN(port) || port < 1) {
    throw new Error("PORT must be a positive integer.");
  }
  return { opensearchUrl, opensearchUser, opensearchPassword, bind, port };
}

export const facetAttributes = [
  {
    attribute: "board_slug",
    field: "board.urlName",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "board_name",
    field: "board.name.keyword",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "status",
    field: "status",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "category_name",
    field: "category.name.keyword",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "author_name",
    field: "author.name.keyword",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "aiCategories",
    field: "aiCategories.keyword",
    type: "string" as const,
    facetQuery: slugSafeFacetQuery,
  },
  { attribute: "vote_highEngagement", field: "voteSettings.highEngagement", type: "string" as const },
  { attribute: "vote_lowEngagement", field: "voteSettings.lowEngagement", type: "string" as const },
  { attribute: "vote_moderateEngagement", field: "voteSettings.moderateEngagement", type: "string" as const },
  { attribute: "score", field: "score", type: "numeric" as const },
  { attribute: "maxScore", field: "maxScore", type: "numeric" as const },
  { attribute: "commentCount", field: "commentCount", type: "numeric" as const },
  { attribute: "mergeCount", field: "mergeCount", type: "numeric" as const },
  { attribute: "trendingScore", field: "trendingScore", type: "numeric" as const },
  { attribute: "post_created", field: "created", type: "numeric" as const },
  { attribute: "post_updated", field: "updatedAt", type: "numeric" as const },
  { attribute: "post_statusChanged", field: "statusChanged", type: "numeric" as const },
  {
    attribute: "voter_name",
    field: "name.keyword",
    type: "string" as const,
    nestedPath: "voters",
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "comment_author_name",
    field: "author.name.keyword",
    type: "string" as const,
    nestedPath: "comments",
    facetQuery: slugSafeFacetQuery,
  },
  {
    attribute: "comment_pinned",
    field: "pinned",
    type: "string" as const,
    nestedPath: "comments",
  },
  {
    attribute: "comment_likeCount",
    field: "likeCount",
    type: "numeric" as const,
    nestedPath: "comments",
  },
  {
    attribute: "comment_created",
    field: "created",
    type: "numeric" as const,
    nestedPath: "comments",
  },
];

export function searchkitConfig(host: string, username: string, password: string) {
  return {
    connection: {
      host,
      auth: {
        username,
        password,
      },
    },
    search_settings: {
      search_attributes: textSearchAttributes,
      // Explicit list of every top-level field we want to return so that the
      // gateway-side _source filter does not accidentally drop nested objects
      // (comments, board, author, ...). Keep this in sync with index_mappings.json.
      result_attributes: [
        "post_id",
        "__v",
        "title",
        "details",
        "urlName",
        "ideaID",
        "boardID",
        "categoryID",
        "subCategoryID",
        "companyID",
        "authorID",
        "deleteID",
        "deletedBy",
        "updatedBy",
        "by",
        "byID",
        "status",
        "score",
        "maxScore",
        "mergeCount",
        "trendingScore",
        "commentCount",
        "viewerVote",
        "viewerIsAuthor",
        "loading",
        "notFound",
        "etaPublic",
        "eta",
        "ogImageURL",
        "imageURLs",
        "fileURLs",
        "opportunities",
        "created",
        "updatedAt",
        "statusChanged",
        "lastActivityAt",
        "deletedAt",
        "lastUpdated",
        "error",
        "linkedEntry",
        "sourceFeatureExtractionItem",
        "files",
        "author",
        "board",
        "category",
        "voteSettings",
        "voters",
        "comments",
        "pinnedComment",
        "aiCategories",
        "aiTaggedAt",
      ],
      highlight_attributes: ["title", "details", "author.name"],
      snippet_attributes: ["details:200"],
      facet_attributes: facetAttributes,
      sorting: {
        // Default (unsuffixed index name) sorts newest-first.
        default: {
          field: "created",
          order: "desc" as const,
        },
        // Keys must include the leading "_" so Searchkit's strip logic removes
        // "feedback-posts_created_asc" -> "feedback-posts", not "feedback-posts_".
        _created_asc: {
          field: "created",
          order: "asc" as const,
        },
        _score_desc: {
          field: "score",
          order: "desc" as const,
        },
        _score_asc: {
          field: "score",
          order: "asc" as const,
        },
        // Score first, then newer posts when two hits share a score.
        _relevance_desc: [
          { field: "_score", order: "desc" as const },
          { field: "created", order: "desc" as const },
        ],
        _activity_desc: {
          field: "lastActivityAt",
          order: "desc" as const,
        },
        _activity_asc: {
          field: "lastActivityAt",
          order: "asc" as const,
        },
        _statusChanged_desc: {
          field: "statusChanged",
          order: "desc" as const,
        },
        _statusChanged_asc: {
          field: "statusChanged",
          order: "asc" as const,
        },
      },
      query_rules: [],
    },
  };
}
