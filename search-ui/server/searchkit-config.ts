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
      result_attributes: ["*"],
      highlight_attributes: ["title", "details", "author.name"],
      snippet_attributes: ["details:200"],
      facet_attributes: [
        { attribute: "board.urlName", field: "board.urlName", type: "string" },
        { attribute: "board.name", field: "board.name.keyword", type: "string" },
        { attribute: "status", field: "status", type: "string" },
        { attribute: "score", field: "score", type: "numeric" },
        { attribute: "commentCount", field: "commentCount", type: "numeric" },
      ],
      sorting: {
        default: {
          field: "_score",
          order: "desc" as const,
        },
        // Keys must include the leading "_" so Searchkit's strip logic removes
        // "feedback-posts_created_desc" -> "feedback-posts", not "feedback-posts_".
        _created_desc: {
          field: "created",
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
