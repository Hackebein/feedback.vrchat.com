import API from "@searchkit/api";
import express from "express";
import type { MultipleQueriesQuery, SearchRequest } from "searchkit";
import {
  buildAgentPostBody,
  buildAgentSearchBody,
  mapAgentPost,
  mapAgentSearchResponse,
  parseAgentSearchQuery,
  queryOpenSearch,
  SERVICE_LINK,
} from "./agent-api";
import { applyExcludeFacets } from "./facet-exclusion";
import { parseNonNegativeInt, parsePositiveInt } from "./http-params";
import { createIndexGenerationResolver } from "./index-generation";
import {
  gatewayEnv,
  instantSearchLuceneQuery,
  instantSearchStrictQuery,
  searchkitConfig,
} from "./searchkit-config";

const INDEX_NAME = "feedback-posts";

const { opensearchUrl, opensearchUser, opensearchPassword, bind, port } =
  gatewayEnv();

const apiClient = API(searchkitConfig(opensearchUrl, opensearchUser, opensearchPassword));
const resolveIndexGeneration = createIndexGenerationResolver({
  opensearchUrl,
  opensearchUser,
  opensearchPassword,
  alias: INDEX_NAME,
});

function parseMode(raw: unknown): string {
  const v =
    typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
  return v.trim().toLowerCase();
}

function isLuceneMode(req: express.Request): boolean {
  return parseMode(req.query.mode) === "lucene";
}

function searchRequestOptions(lucene: boolean) {
  return {
    getQuery: lucene ? instantSearchLuceneQuery : instantSearchStrictQuery,
    hooks: {
      beforeSearch: async (requests: SearchRequest[]) => applyExcludeFacets(requests),
    },
  };
}

function extractElasticsearchBadRequestDetail(err: unknown): string | undefined {
  if (!(err instanceof Error)) {
    return undefined;
  }
  const msg = err.message;
  try {
    const parsed = JSON.parse(msg) as {
      responses?: Array<{ status?: number; error?: unknown }>;
      status?: number;
    };
    const first = parsed.responses?.[0];
    if (parsed.status === 400 || first?.status === 400) {
      if (first?.error !== undefined && first.error !== null) {
        return typeof first.error === "string"
          ? first.error
          : JSON.stringify(first.error);
      }
      return msg;
    }
  } catch {
    /* not Searchkit JSON error */
  }
  if (/Elasticsearch request failed with status 400\b/.test(msg)) {
    return msg;
  }
  return undefined;
}

function getDiscoveryJson() {
  return {
    endpoints: {
      POST: "/api/search",
      GET: "/api/search?q=terms&hitsPerPage=50&page=0",
      agentSearch: "/api/agent/search?q=terms&limit=10&page=0",
      agentPost: "/api/agent/posts/{board}/{urlName}",
      index: "/api/index",
      openapi: "/openapi.json",
    },
    description:
      "Agents: GET /api/agent/search (short hits) and GET /api/agent/posts/{board}/{urlName} (one post, truncated). UI: POST JSON array of InstantSearch multiple-queries, or GET /api/search?q=&hitsPerPage=&page= (see /openapi.json). GET with no search params returns this document. Optional mode=lucene on /api/search uses OpenSearch query_string. GET /api/index returns the current OpenSearch backing index name. Contract: openapi.json.",
  };
}

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use((_req, res, next) => {
  res.setHeader("Link", SERVICE_LINK);
  next();
});

const openSearchTarget = {
  opensearchUrl,
  opensearchUser,
  opensearchPassword,
  index: INDEX_NAME,
};

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
});

app.get("/api/index", async (_req, res) => {
  try {
    const index = await resolveIndexGeneration();
    res.setHeader("Cache-Control", "no-store");
    res.json({ index });
  } catch (err) {
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "index lookup failed" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const qRaw = req.query.q ?? req.query.query;
    const queryText =
      typeof qRaw === "string" ? qRaw : Array.isArray(qRaw) ? String(qRaw[0] ?? "") : "";

    const hasSearchParams =
      qRaw !== undefined ||
      req.query.hitsPerPage !== undefined ||
      req.query.page !== undefined;

    if (!hasSearchParams) {
      res.json(getDiscoveryJson());
      return;
    }

    const hitsPerPage = parsePositiveInt(req.query.hitsPerPage, 50, 500);
    const page = parseNonNegativeInt(req.query.page, 0, 9999);

    const instantsearchRequests: MultipleQueriesQuery[] = [
      {
        indexName: INDEX_NAME,
        params: {
          query: queryText,
          hitsPerPage,
          page,
        },
      },
    ];

    const opts = searchRequestOptions(isLuceneMode(req));

    const results = await apiClient.handleRequest(instantsearchRequests, opts);
    res.json(results);
  } catch (err) {
    const detail = extractElasticsearchBadRequestDetail(err);
    if (detail !== undefined) {
      res.status(400).json({ message: "Invalid search query", detail });
      return;
    }
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "search failed" });
  }
});

app.post("/api/search", async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      res
        .status(400)
        .json({
          message:
            "Expected a JSON array of InstantSearch multiple-queries payloads",
        });
      return;
    }
    const opts = searchRequestOptions(isLuceneMode(req));

    const results = await apiClient.handleRequest(
      req.body as MultipleQueriesQuery[],
      opts,
    );
    res.json(results);
  } catch (err) {
    const detail = extractElasticsearchBadRequestDetail(err);
    if (detail !== undefined) {
      res.status(400).json({ message: "Invalid search query", detail });
      return;
    }
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "search failed" });
  }
});

function sendAgentQueryError(
  res: express.Response,
  result: { httpStatus: 400 | 500; message: string; detail?: string },
): void {
  if (result.httpStatus === 500) {
    console.error("[search-gateway]", result.detail ?? result.message);
    res.status(500).json({ message: "search failed" });
    return;
  }
  res.status(400).json(
    result.detail
      ? { message: result.message, detail: result.detail }
      : { message: result.message },
  );
}

app.get("/api/agent/search", async (req, res) => {
  const parsed = parseAgentSearchQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  try {
    const result = await queryOpenSearch(
      openSearchTarget,
      buildAgentSearchBody(parsed.params),
    );
    if (!result.ok) {
      sendAgentQueryError(res, result);
      return;
    }
    res.json(mapAgentSearchResponse(result.body, parsed.params));
  } catch (err) {
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "search failed" });
  }
});

app.get("/api/agent/posts/:board/:urlName", async (req, res) => {
  const board = req.params.board.trim();
  const urlName = req.params.urlName.trim();
  if (!board || !urlName) {
    res.status(404).json({ message: "post not found" });
    return;
  }
  try {
    const result = await queryOpenSearch(
      openSearchTarget,
      buildAgentPostBody(board, urlName),
    );
    if (!result.ok) {
      sendAgentQueryError(res, result);
      return;
    }
    const post = mapAgentPost(result.body);
    if (!post) {
      res.status(404).json({ message: "post not found" });
      return;
    }
    res.json(post);
  } catch (err) {
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "search failed" });
  }
});

app.listen(port, bind, () => {
  console.info(`listening addr=${bind} port=${port} service=feedback-search-gateway`);
});
