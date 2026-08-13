import API from "@searchkit/api";
import express from "express";
import type { MultipleQueriesQuery } from "searchkit";
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

function parseNonNegativeInt(
  raw: unknown,
  fallback: number,
  max: number,
): number {
  const n =
    typeof raw === "string" || typeof raw === "number"
      ? Number.parseInt(String(raw), 10)
      : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
}

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const n = parseNonNegativeInt(raw, fallback, max);
  return n <= 0 ? fallback : Math.min(n, max);
}

function getDiscoveryJson() {
  return {
    endpoints: {
      POST: "/api/search",
      GET: "/api/search?q=terms&hitsPerPage=50&page=0",
      index: "/api/index",
      openapi: "/openapi.json",
    },
    description:
      "POST: JSON array of InstantSearch multiple-queries (see /openapi.json). GET: discovery when no search params; otherwise one-query search (q/query, hitsPerPage, page) — subset of POST. Optional query param mode=lucene uses OpenSearch query_string (Lucene) for params.query instead of strict multi_match. GET /api/index returns the current OpenSearch backing index name so clients can refresh when ingest swaps the alias. Contract: openapi.json.",
  };
}

const app = express();
app.use(express.json({ limit: "512kb" }));

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

app.listen(port, bind, () => {
  console.info(`listening addr=${bind} port=${port} service=feedback-search-gateway`);
});
