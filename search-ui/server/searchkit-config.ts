import type {
  ElasticsearchQuery,
  SearchAttribute,
  SearchSettingsConfig,
} from "searchkit";
import indexMappings from "../../deploy/opensearch/index_mappings.json" with { type: "json" };
import { buildLuceneQueryBody } from "./lucene-query";
import { phraseAnalyzer, phraseSearchFields } from "./phrase-mode";

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

export function instantSearchLuceneQuery(
  query: string,
  _searchAttributes: SearchAttribute[],
  _config: SearchSettingsConfig,
): ElasticsearchQuery {
  return buildLuceneQueryBody(query.trim());
}

export const textSearchAttributes: SearchAttribute[] = [
  { field: "combined_text", weight: 3 },
  { field: "title", weight: 2 },
  { field: "author.name", weight: 1 },
  "details",
];

/**
 * Exact identifier hits sit on a constant-score band above every fuzzy hit.
 * Fuzzy edit distance is 1 only for terms of length >= 5 (`AUTO:5,100` is 0
 * below 5, 1 until 100) and only against the unstemmed `.exact` subfield.
 * `AUTO` after the English stemmer is what made `groupIds` (stem `groupid`)
 * match every post whose stem is `group`.
 *
 * Unquoted text is scored as a bag of single terms. A phrase clause on the
 * whole string changed scores with word order (`full body` ranked the in-order
 * post above `body full`). `synonym_graph` only expands a multi-word synonym
 * in the listed order, so `full body tracking` matched an `fbt` post and
 * `tracking body full` did not. Quoted phrases stay ordered and use the
 * `text_phrase` analyzer on `.phrase` (stem, keep stop words, no synonyms).
 * English stop words are dropped before an unquoted term is required. A query
 * that is only stop words is `match_all`: nothing remains to rank. Unquoted
 * `groupIds` is the tokens `group` and `id`, so those words in different
 * sentences still match, under an exact identifier hit.
 */
const EXACT_BAND_BOOST = 1000;
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

function phraseQuery(phrase: string, fields: string[]): ElasticsearchQuery {
  return {
    multi_match: {
      query: phrase,
      type: "phrase",
      fields: phraseSearchFields(fields),
      analyzer: phraseAnalyzer(),
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

type TermPlan =
  | { kind: "synonym"; words: string[]; singles: string[] }
  | { kind: "term"; term: string };

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
      plans.push({ kind: "term", term: text });
    }
  }
  return plans;
}

function planClause(plan: TermPlan, searchAttributes: SearchAttribute[]): ElasticsearchQuery {
  switch (plan.kind) {
    case "term":
      return termClause(plan.term, searchAttributes);
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
): ElasticsearchQuery {
  const q = query.trim();
  if (!q) {
    return { match_all: {} };
  }
  const { phrases, terms } = partitionPlainQuery(q);
  const phraseFields = fieldsWithBoost(searchAttributes, 2);
  const must: ElasticsearchQuery[] = phrases.map((phrase) => phraseQuery(phrase, phraseFields));
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
        _relevance_desc: {
          field: "_score",
          order: "desc" as const,
        },
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
