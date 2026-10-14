/**
 * Prints latency and clause estimates for worst-case searches.
 * `npm run bench:search` from search-ui. Needs OpenSearch 2.19.5 at
 * OPENSEARCH_URL (default http://127.0.0.1:9200). The CI check is
 * scripts/test-search-perf.ts.
 */
import { performance } from "node:perf_hooks";
import { buildLuceneQueryBody } from "../server/lucene-query";
import {
  instantSearchStrictQuery,
  plainQueryClauseEstimate,
  textSearchAttributes,
} from "../server/searchkit-config";
import {
  bulkIndex,
  deleteIndex,
  recreateIndex,
  saturatedCorpus,
  searchQuery,
  searchUrl,
} from "./opensearch-harness";
import { stressCases } from "./search-stress-cases";

const rounds = Number(process.env.SEARCH_BENCH_ROUNDS ?? "5");
const index = "feedback-search-bench";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main(): Promise<void> {
  const root = await fetch(searchUrl());
  const version = ((await root.json()) as { version?: { number?: string } }).version?.number;
  const { bases, docs } = saturatedCorpus();
  await recreateIndex(index);
  try {
    await bulkIndex(index, docs);
    console.info(`OpenSearch ${version ?? "unknown"}  docs=${docs.length}  rounds=${rounds}`);
    console.info("label\tkind\tclauses\tbuild_ms\ttook_p50\ttook_max\tstatus");
    for (const item of stressCases(bases)) {
      const started = performance.now();
      const query =
        item.kind === "plain"
          ? instantSearchStrictQuery(item.query, textSearchAttributes)
          : buildLuceneQueryBody(item.query);
      const buildMs = performance.now() - started;
      const clauses = item.kind === "plain" ? plainQueryClauseEstimate(item.query) : "";
      const tooks: number[] = [];
      let status = 0;
      for (let round = 0; round < rounds; round += 1) {
        const result = await searchQuery(index, query, 5);
        status = result.status;
        if (result.took !== null) {
          tooks.push(result.took);
        }
      }
      const max = tooks.length > 0 ? Math.max(...tooks) : "";
      console.info(`${item.label}\t${item.kind}\t${clauses}\t${buildMs.toFixed(1)}\t${tooks.length > 0 ? median(tooks) : ""}\t${max}\t${status}`);
    }
  } finally {
    await deleteIndex(index);
  }
}

await main();
