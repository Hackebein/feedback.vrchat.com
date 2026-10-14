import type {
  ElasticsearchQuery,
  SearchAttribute,
  SearchSettingsConfig,
} from "searchkit";
import indexMappings from "../../deploy/opensearch/index_mappings.json" with { type: "json" };
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
 */
const EXACT_BAND_BOOST = 1000;
const ADJACENT_BAND_BOOST = 50;
const FUZZY_BAND_BOOST = 5;

/** Same set as the `english_stop` filter (`_english_`). These tokens are deleted by the search analyzer, so they must not become required clauses. */
const ENGLISH_STOP: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "if",
  "in",
  "into",
  "is",
  "it",
  "no",
  "not",
  "of",
  "on",
  "or",
  "such",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "will",
  "with",
]);

/** CamelCase and letter/number boundaries have to reach the search analyzer intact. Lowercasing first hides the split. */
function preservesCase(token: string): boolean {
  return /[a-z][A-Z]/.test(token) || /[A-Za-z]\d|\d[A-Za-z]/.test(token);
}

/**
 * Same boundaries as the `text_search` char filters. Content parts drop stop
 * words. `phraseParts` keeps a stop word that sits between content parts so
 * `.phrase` can match “end of line” without treating that hole as free slop.
 */
function splitIdentifier(token: string): { parts: string[]; phraseParts: string[] } {
  const raw = token
    .replace(/(?<=\p{Ll})(?=\p{Lu})/gu, " ")
    .replace(/(?<=\p{L})(?=\p{N})/gu, " ")
    .replace(/(?<=\p{N})(?=\p{L})/gu, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const contentAt: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!ENGLISH_STOP.has((raw[index] ?? "").toLowerCase())) {
      contentAt.push(index);
    }
  }
  const parts = contentAt.map((index) => raw[index] ?? "");
  if (contentAt.length < 2) {
    return { parts, phraseParts: [] };
  }
  const span = raw.slice(contentAt[0], contentAt[contentAt.length - 1]! + 1);
  const phraseParts = span.some((part) => ENGLISH_STOP.has(part.toLowerCase())) ? span : [];
  return { parts, phraseParts };
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
        : { prefix_length: 1, max_expansions: 50, fuzzy_transpositions: true }),
    },
  };
}

function scoreBand(
  query: string,
  fields: string[],
  fuzziness: 0 | "AUTO:5,100",
  boost: number,
): ElasticsearchQuery {
  return {
    constant_score: {
      boost,
      filter: bestFields(query, fields, fuzziness),
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

function termClause(term: string, searchAttributes: SearchAttribute[]): ElasticsearchQuery {
  const should: ElasticsearchQuery[] = [
    scoreBand(term, exactFields(searchAttributes), 0, EXACT_BAND_BOOST),
    bestFields(term, fieldsWithBoost(searchAttributes, 1), 0),
  ];
  if (term.length >= 5) {
    should.push(scoreBand(term, exactFields(searchAttributes), "AUTO:5,100", FUZZY_BAND_BOOST));
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
    should.push(proximity);
  } else if (parts.length === 1) {
    should.push(bestFields(parts[0]!, fieldsWithBoost(searchAttributes, 1), 0));
  }
  if (term.length >= 5) {
    should.push(scoreBand(term, exactFields(searchAttributes), "AUTO:5,100", FUZZY_BAND_BOOST));
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
    if (!spellings.has(key) || preservesCase(token)) {
      spellings.set(key, preservesCase(token) ? token : key);
    }
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
        const split = splitIdentifier(text);
        plans.push({
          kind: "identifier",
          term: text,
          parts: split.parts,
          phraseParts: split.phraseParts,
          singles: synonymSingles(split.parts),
        });
      } else {
        plans.push({ kind: "term", term: text });
      }
    }
  }
  return plans;
}

function planClause(plan: TermPlan, searchAttributes: SearchAttribute[]): ElasticsearchQuery {
  switch (plan.kind) {
    case "term":
      return termClause(plan.term, searchAttributes);
    case "identifier": {
      const identifier = identifierClause(
        plan.term,
        plan.parts,
        plan.phraseParts,
        searchAttributes,
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
    case "synonym":
      return {
        bool: {
          should: [
            {
              bool: {
                must: plan.words.map((word) => termClause(word, searchAttributes)),
              },
            },
            ...plan.singles.map((single) => termClause(single, searchAttributes)),
          ],
          minimum_should_match: 1,
        },
      };
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

export function instantSearchStrictQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  _config?: SearchSettingsConfig,
  mode: PhraseMode = "strict",
): ElasticsearchQuery {
  const q = query.trim();
  if (!q) {
    return { match_all: {} };
  }
  const { phrases, terms } = partitionPlainQuery(q);
  const phraseFields = fieldsWithBoost(searchAttributes, 2);
  const must: ElasticsearchQuery[] = phrases.map((phrase) =>
    phraseQuery(phrase, phraseFields, mode),
  );
  if (terms) {
    for (const plan of planUnquotedTerms(terms)) {
      must.push(planClause(plan, searchAttributes));
    }
  }
  if (must.length === 0) {
    return { match_all: {} };
  }
  return { bool: { must } };
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
