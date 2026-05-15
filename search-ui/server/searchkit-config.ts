import type {
  ElasticsearchQuery,
  FacetFieldConfig,
  SearchAttribute,
  SearchSettingsConfig,
} from "searchkit";

function fieldsWithBoost(attrs: SearchAttribute[], mult: number): string[] {
  return attrs.map((a) =>
    typeof a === "string"
      ? `${a}^${mult}`
      : `${a.field}^${(a.weight ?? 1) * mult}`,
  );
}

/** Facet definitions shared with `mergeLuceneFilters` (same shape as Searchkit `facet_attributes`). */
export const FACET_ATTRIBUTES: FacetFieldConfig[] = [
  { attribute: "board_slug", field: "board.urlName", type: "string" },
  { attribute: "board_name", field: "board.name.keyword", type: "string" },
  { attribute: "status", field: "status", type: "string" },
  { attribute: "category_name", field: "category.name.keyword", type: "string" },
  { attribute: "author_name", field: "author.name.keyword", type: "string" },
  {
    attribute: "vote_highEngagement",
    field: "voteSettings.highEngagement",
    type: "string",
  },
  {
    attribute: "vote_lowEngagement",
    field: "voteSettings.lowEngagement",
    type: "string",
  },
  {
    attribute: "vote_moderateEngagement",
    field: "voteSettings.moderateEngagement",
    type: "string",
  },
  { attribute: "score", field: "score", type: "numeric" },
  { attribute: "maxScore", field: "maxScore", type: "numeric" },
  { attribute: "commentCount", field: "commentCount", type: "numeric" },
  { attribute: "mergeCount", field: "mergeCount", type: "numeric" },
  { attribute: "trendingScore", field: "trendingScore", type: "numeric" },
  {
    attribute: "comment_author_name",
    field: "author.name.keyword",
    type: "string",
    nestedPath: "comments",
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
];

export type FacetMapEntry = {
  field: string;
  type: "string" | "numeric" | "date";
  nestedPath?: string;
};

export const FACET_ATTRIBUTE_MAP: Record<string, FacetMapEntry> = Object.fromEntries(
  FACET_ATTRIBUTES.map((f) => [
    f.attribute,
    {
      field: f.field,
      type: f.type,
      ...(f.nestedPath ? { nestedPath: f.nestedPath } : {}),
    },
  ]),
);

/**
 * Full-text query using Lucene `query_string` grammar against boosted search fields.
 */
export function luceneQuery(
  query: string,
  searchAttributes: SearchAttribute[],
  _config: SearchSettingsConfig,
): ElasticsearchQuery {
  const q = query.trim();
  if (!q) {
    return { match_all: {} };
  }
  return {
    query_string: {
      query: q,
      fields: fieldsWithBoost(searchAttributes, 1),
      default_operator: "AND",
      allow_leading_wildcard: false,
      analyze_wildcard: true,
      fuzzy_max_expansions: 50,
      lenient: true,
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
      ],
      highlight_attributes: ["title", "details", "author.name"],
      snippet_attributes: ["details:200"],
      facet_attributes: FACET_ATTRIBUTES,
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
      },
      query_rules: [],
    },
  };
}
