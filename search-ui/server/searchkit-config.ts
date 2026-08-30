import type {
  ElasticsearchQuery,
  SearchAttribute,
  SearchSettingsConfig,
} from "searchkit";
import { buildLuceneQueryBody } from "./lucene-query";

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

/**
 * Hidden from public search even if they are still in the backing index.
 */
export const RESTRICTED_BOARD_SLUGS = [
  "archived",
  "avatar-dynamics-reports-and-feedback",
  "avatar-marketplace-sellers",
  "community-labs",
  "creator-economy-sellers",
  "face-tracking",
  "groups",
  "internal",
  "quest-creators",
  "trust-and-safety-system",
  "unity-6",
  "vrchat-community-testers",
  "vrchat-plus-feedback",
] as const;

/** Searchkit base filter so restricted boards never appear in hits or facets. */
export function restrictedBoardBaseFilters(): ElasticsearchQuery[] {
  return [
    {
      bool: {
        must_not: [
          { terms: { "board.urlName": [...RESTRICTED_BOARD_SLUGS] } },
        ],
      },
    },
  ];
}

export function instantSearchLuceneQuery(
  query: string,
  _searchAttributes: SearchAttribute[],
  _config: SearchSettingsConfig,
): ElasticsearchQuery {
  return buildLuceneQueryBody(query.trim());
}

export function instantSearchStrictQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  _config: SearchSettingsConfig,
): ElasticsearchQuery {
  const q = query.trim();
  if (!q) {
    return { match_all: {} };
  }
  // For very short queries (1 character) we keep behavior conservative: require
  // the *entire* analyzed query to appear as a phrase so that typing "G" while
  // searching for "Group" doesn't sweep in every document that happens to
  // contain a stray bare letter token.
  const primary = fieldsWithBoost(searchAttributes, 1);
  const phrase = fieldsWithBoost(searchAttributes, 2);
  const should: ElasticsearchQuery[] = [
    {
      multi_match: {
        query: q,
        fields: primary,
        type: "best_fields",
        operator: "and",
        fuzziness: 0,
        auto_generate_synonyms_phrase_query: false,
      },
    },
    {
      multi_match: {
        query: q,
        type: "phrase",
        fields: phrase,
      },
    },
  ];
  if (q.length > 2) {
    should.push({
      multi_match: {
        query: q,
        fields: fieldsWithBoost(searchAttributes, 0.5),
        type: "best_fields",
        operator: "and",
        fuzziness: "AUTO",
        prefix_length: 1,
        max_expansions: 50,
        auto_generate_synonyms_phrase_query: false,
      },
    });
  }
  return {
    bool: {
      should,
      minimum_should_match: 1,
    },
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
      search_attributes: [
        { field: "combined_text", weight: 3 },
        { field: "title", weight: 2 },
        { field: "author.name", weight: 1 },
        "details",
      ],
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
      facet_attributes: [
        {
          attribute: "board_slug",
          field: "board.urlName",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "board_name",
          field: "board.name.keyword",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "status",
          field: "status",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "category_name",
          field: "category.name.keyword",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "author_name",
          field: "author.name.keyword",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "aiCategories",
          field: "aiCategories.keyword",
          type: "string",
          facetQuery: slugSafeFacetQuery,
        },
        { attribute: "vote_highEngagement", field: "voteSettings.highEngagement", type: "string" },
        { attribute: "vote_lowEngagement", field: "voteSettings.lowEngagement", type: "string" },
        { attribute: "vote_moderateEngagement", field: "voteSettings.moderateEngagement", type: "string" },
        { attribute: "score", field: "score", type: "numeric" },
        { attribute: "maxScore", field: "maxScore", type: "numeric" },
        { attribute: "commentCount", field: "commentCount", type: "numeric" },
        { attribute: "mergeCount", field: "mergeCount", type: "numeric" },
        { attribute: "trendingScore", field: "trendingScore", type: "numeric" },
        { attribute: "post_created", field: "created", type: "numeric" },
        { attribute: "post_updated", field: "updatedAt", type: "numeric" },
        { attribute: "post_statusChanged", field: "statusChanged", type: "numeric" },
        {
          attribute: "voter_name",
          field: "name.keyword",
          type: "string",
          nestedPath: "voters",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "comment_author_name",
          field: "author.name.keyword",
          type: "string",
          nestedPath: "comments",
          facetQuery: slugSafeFacetQuery,
        },
        {
          attribute: "comment_pinned",
          field: "pinned",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_likeCount",
          field: "likeCount",
          type: "numeric",
          nestedPath: "comments",
        },
        {
          attribute: "comment_created",
          field: "created",
          type: "numeric",
          nestedPath: "comments",
        },
      ],
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
