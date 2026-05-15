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
        "details",
      ],
      result_attributes: [
        "post_id",
        "title",
        "details",
        "board_slug",
        "board_name",
        "status",
        "score",
        "comment_count",
        "created_at",
        "updated_at",
        "url_name",
        "has_images",
        "has_files",
      ],
      highlight_attributes: ["title", "details"],
      snippet_attributes: ["details:200"],
      facet_attributes: [
        { attribute: "board_slug", field: "board_slug", type: "string" },
        { attribute: "board_name", field: "board_name.keyword", type: "string" },
        { attribute: "status", field: "status", type: "string" },
        { attribute: "score", field: "score", type: "numeric" },
        { attribute: "comment_count", field: "comment_count", type: "numeric" },
      ],
      sorting: {
        default: {
          field: "_score",
          order: "desc" as const,
        },
        // Keys must include the leading "_" so Searchkit's strip logic removes
        // "feedback-posts_created_at_desc" -> "feedback-posts", not "feedback-posts_".
        _created_at_desc: {
          field: "created_at",
          order: "desc" as const,
        },
        _score_desc: {
          field: "score",
          order: "desc" as const,
        },
      },
      query_rules: [],
    },
  };
}
