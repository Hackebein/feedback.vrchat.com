import type {
  ElasticsearchQuery,
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
  return {
    bool: {
      should: [
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
      ],
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
      facet_attributes: [
        { attribute: "board_slug", field: "board.urlName", type: "string" },
        { attribute: "board_name", field: "board.name.keyword", type: "string" },
        { attribute: "status", field: "status", type: "string" },
        { attribute: "category_name", field: "category.name.keyword", type: "string" },
        { attribute: "author_name", field: "author.name.keyword", type: "string" },
        { attribute: "author_anonymized", field: "author.anonymized", type: "string" },
        { attribute: "author_serviceAccount", field: "author.serviceAccount", type: "string" },
        { attribute: "eta", field: "eta", type: "string" },
        { attribute: "etaPublic", field: "etaPublic", type: "string" },
        { attribute: "viewerIsAuthor", field: "viewerIsAuthor", type: "string" },
        { attribute: "by", field: "by", type: "string" },
        { attribute: "vote_highEngagement", field: "voteSettings.highEngagement", type: "string" },
        { attribute: "vote_lowEngagement", field: "voteSettings.lowEngagement", type: "string" },
        { attribute: "vote_moderateEngagement", field: "voteSettings.moderateEngagement", type: "string" },
        { attribute: "vote_votesHidden", field: "voteSettings.votesHidden", type: "string" },
        { attribute: "score", field: "score", type: "numeric" },
        { attribute: "maxScore", field: "maxScore", type: "numeric" },
        { attribute: "commentCount", field: "commentCount", type: "numeric" },
        { attribute: "mergeCount", field: "mergeCount", type: "numeric" },
        { attribute: "trendingScore", field: "trendingScore", type: "numeric" },
        { attribute: "viewerVote", field: "viewerVote", type: "numeric" },
        {
          attribute: "comment_author_name",
          field: "comments.author.name.keyword",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_author_anonymized",
          field: "comments.author.anonymized",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_author_serviceAccount",
          field: "comments.author.serviceAccount",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_aiGenerated",
          field: "comments.aiGenerated",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_pinned",
          field: "comments.pinned",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_internal",
          field: "comments.internal",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_private",
          field: "comments.private",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_integrationSourceType",
          field: "comments.integrationSourceType",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_itemSourceType",
          field: "comments.itemSourceType",
          type: "string",
          nestedPath: "comments",
        },
        {
          attribute: "comment_likeCount",
          field: "comments.likeCount",
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
      },
      query_rules: [],
    },
  };
}
