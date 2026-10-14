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
 * of 1024. A fuzzy term rewrites to one clause per expansion on every searched
 * `.exact` field, plus one exact-band clause and one analyzed clause per
 * searched field: `fieldCount * (max_expansions + 2)`. The field list is
 * {@link textSearchAttributes}. With all four fields saturated, 5 terms at
 * `max_expansions` 50 are 1040 clauses and return 500; 4 terms at 50 are 832
 * and return 200. Fuzzy words share {@link FUZZY_CLAUSE_BUDGET}, 256 under
 * 1024, so adding a searched field shrinks `max_expansions` on its own. A
 * normal 5–10 word query keeps a fuzzy band on every eligible word;
 * `max_expansions` shrinks before any fuzzy band is removed. Above 40
 * identifiers the scoring proximity copy is dropped.
 * Adjacent parts share a budget of 160: 80 two-part identifiers succeed, and
 * 68 three-part identifiers do not. Distinct terms the user typed are
 * kept. Repeated copies collapse to one AND clause. Terms are removed only
 * after fuzzy and that extra band are already degraded, shortest first, and
 * the removed terms are returned as `omittedTerms`. An identifier with more
 * than 8 parts is one token, so a long camelCase string cannot build a giant
 * intervals query.
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
/** Shared by every fuzzy word. Cost is `exactFieldCount * (max_expansions + 2)`. */
export const FUZZY_CLAUSE_BUDGET = OPENSEARCH_MAX_CLAUSE_COUNT - FUZZY_CLAUSE_MARGIN;
/** Exact band and analyzed best_fields band, one clause per searched field. */
const BANDS_PER_FIELD = 2;
const PHRASE_CLAUSE_COST = 8;
/** Added to the term cost. 40 full identifier clauses stay under 1024; 52 do not. */
const IDENTIFIER_FULL_EXTRA = 12;
/** Added when the scoring proximity copy is omitted. */
const IDENTIFIER_BAND_EXTRA = 4;
const FULL_IDENTIFIER_BUDGET = 40;
/**
 * Sum of adjacent parts across identifiers. 80 two-part identifiers (160)
 * return 200. 64 three-part identifiers return 200 and 68 return 500.
 */
const PROXIMITY_PART_BUDGET = 160;
const PLAIN_TERM_BUDGET = 100;
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

function synonymGroupsFromLines(lines: readonly string[]): SynonymGroup[] {
  const groups: SynonymGroup[] = [];
  for (const line of lines) {
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
    if (singles.length > 0 && phrases.length > 0) {
      groups.push({ singles, phrases });
    }
  }
  return groups;
}

const SYNONYM_GROUPS = synonymGroupsFromLines(readSynonymLines(indexMappings));

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

function termUnits(plan: TermPlan): number {
  switch (plan.kind) {
    case "term":
      return 1;
    case "identifier":
      return 1 + plan.singles.length;
    case "synonym":
      return plan.words.length + plan.singles.length;
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

function proximityCount(planned: readonly BudgetTerm[]): number {
  return planned.filter((item) => hasProximity(item.plan)).length;
}

function proximityWeight(plan: TermPlan): number {
  if (plan.kind !== "identifier") {
    return 0;
  }
  let weight = plan.parts.length >= 2 ? plan.parts.length : 0;
  if (plan.phraseParts.length >= 2) {
    weight += plan.phraseParts.length;
  }
  return weight;
}

function proximityLoad(planned: readonly BudgetTerm[]): number {
  return planned.reduce((sum, item) => sum + proximityWeight(item.plan), 0);
}

function unitCount(planned: readonly BudgetTerm[]): number {
  return planned.reduce((sum, item) => sum + termUnits(item.plan), 0);
}

function clauseCost(
  planned: readonly BudgetTerm[],
  phrases: number,
  maxExpansions: number,
  fieldCount: number,
): number {
  const termCost = fieldCount * BANDS_PER_FIELD;
  const expansionCost = maxExpansions > 0 ? maxExpansions * fieldCount : 0;
  let clauses = phrases * PHRASE_CLAUSE_COST;
  for (const item of planned) {
    const terms = termUnits(item.plan);
    const fuzzy = Math.min(item.fuzzyWords, fuzzyUnits(item.plan));
    clauses += terms * termCost + fuzzy * expansionCost;
    if (hasProximity(item.plan)) {
      clauses += item.scoreProximity ? IDENTIFIER_FULL_EXTRA : IDENTIFIER_BAND_EXTRA;
    }
  }
  return clauses;
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

function trimPlain(
  plans: readonly TermPlan[],
  phraseList: readonly string[],
  fieldCount: number,
): { planned: BudgetTerm[]; phrases: string[]; omittedTerms: string[]; maxExpansions: number } {
  let planned: BudgetTerm[] = collapsePlans(plans).map((plan) => ({
    plan,
    fuzzyWords: 0,
    scoreProximity: hasProximity(plan),
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

  if (proximityCount(planned) > FULL_IDENTIFIER_BUDGET) {
    planned = planned.map((item) =>
      hasProximity(item.plan) ? { ...item, scoreProximity: false } : item,
    );
  }
  while (proximityLoad(planned) > PROXIMITY_PART_BUDGET) {
    const index = dropIndex(planned, true);
    if (index < 0) {
      break;
    }
    omitAt(index);
  }
  while (unitCount(planned) > PLAIN_TERM_BUDGET) {
    const index = dropIndex(planned, false);
    if (index < 0) {
      break;
    }
    omitAt(index);
  }

  planned = planned.map((item) => ({ ...item, fuzzyWords: fuzzyUnits(item.plan) }));
  let maxExpansions = expansionFor(fuzzyWordCount(planned), fieldCount);
  while (maxExpansions < MIN_FUZZY_EXPANSIONS && shedFuzzy(planned)) {
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
  while (
    clauseCost(planned, phrases.length, maxExpansions, fieldCount) > PLAIN_CLAUSE_BUDGET &&
    planned.length > 1
  ) {
    if (planned.some((item) => item.scoreProximity && hasProximity(item.plan))) {
      planned = planned.map((item) => ({ ...item, scoreProximity: false }));
      continue;
    }
    if (fuzzyWordCount(planned) > 0) {
      shedFuzzy(planned);
      maxExpansions = expansionFor(fuzzyWordCount(planned), fieldCount);
      if (maxExpansions < MIN_FUZZY_EXPANSIONS) {
        maxExpansions = 0;
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
  while (
    clauseCost(planned, phrases.length, maxExpansions, fieldCount) > PLAIN_CLAUSE_BUDGET &&
    phrases.length > 0
  ) {
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
): CompiledPlainQuery {
  const q = query.trim();
  if (!q) {
    return { query: { match_all: {} }, clauses: 1, omittedTerms: [], expansionSlots: 0 };
  }
  const { phrases, terms } = partitionPlainQuery(q);
  const fieldCount = exactFields(searchAttributes).length;
  const trimmed = trimPlain(terms ? planUnquotedTerms(terms) : [], phrases, fieldCount);
  const phraseFields = fieldsWithBoost(searchAttributes, 2);
  const must: ElasticsearchQuery[] = trimmed.phrases.map((phrase) =>
    phraseQuery(phrase, phraseFields, mode),
  );
  for (const item of trimmed.planned) {
    must.push(
      planClause(
        item.plan,
        searchAttributes,
        item.fuzzyWords,
        trimmed.maxExpansions,
        item.scoreProximity,
      ),
    );
  }
  const expansionSlots = fuzzyWordCount(trimmed.planned) * trimmed.maxExpansions;
  const clauses = clauseCost(
    trimmed.planned,
    trimmed.phrases.length,
    trimmed.maxExpansions,
    fieldCount,
  );
  if (must.length === 0) {
    return { query: { match_all: {} }, clauses: 1, omittedTerms: trimmed.omittedTerms, expansionSlots };
  }
  return { query: { bool: { must } }, clauses, omittedTerms: trimmed.omittedTerms, expansionSlots };
}

export function instantSearchStrictQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  _config?: SearchSettingsConfig,
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
  return compilePlainQuery(query, searchAttributes, mode).query;
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
): PlainQueryLimit {
  const compiled = compilePlainQuery(query, searchAttributes, "strict");
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
      const omittedTerms = lucene ? [] : plainQueryLimit(queries[index] ?? "").omittedTerms;
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
