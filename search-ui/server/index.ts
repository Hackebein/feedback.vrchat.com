import API from "@searchkit/api";
import express from "express";
import type { MultipleQueriesQuery } from "searchkit";
import { mergeLuceneFilters } from "./merge-lucene-filters.js";
import {
  FACET_ATTRIBUTE_MAP,
  gatewayEnv,
  luceneQuery,
  searchkitConfig,
} from "./searchkit-config.js";

const INDEX_NAME = "feedback-posts";

const { opensearchUrl, opensearchUser, opensearchPassword, bind, port } =
  gatewayEnv();

const apiClient = API(searchkitConfig(opensearchUrl, opensearchUser, opensearchPassword));

const searchRequestOptions = {
  getQuery: luceneQuery,
};

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
      openapi: "/openapi.json",
    },
    description:
      "POST: JSON array of InstantSearch multiple-queries (see /openapi.json). params.query is a Lucene query_string. GET: discovery when no search params; otherwise one-query search (q/query is Lucene, hitsPerPage, page) — subset of POST. Contract: openapi.json.",
  };
}

const app = express();
app.use(express.json({ limit: "512kb" }));

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
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

    mergeLuceneFilters(instantsearchRequests, FACET_ATTRIBUTE_MAP);

    const results = await apiClient.handleRequest(
      instantsearchRequests,
      searchRequestOptions,
    );
    res.json(results);
  } catch (err) {
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
    const body = req.body as MultipleQueriesQuery[];
    mergeLuceneFilters(body, FACET_ATTRIBUTE_MAP);

    const results = await apiClient.handleRequest(
      body,
      searchRequestOptions,
    );
    res.json(results);
  } catch (err) {
    console.error("[search-gateway]", err);
    res.status(500).json({ message: "search failed" });
  }
});

app.listen(port, bind, () => {
  console.info(`listening addr=${bind} port=${port} service=feedback-search-gateway`);
});
