/**
 * CI check for worst-case search latency and clause count.
 * The longer table is `npm run bench:search` in search-ui.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildLuceneQueryBody } from "../server/lucene-query";
import {
  EXPANSION_SLOT_BUDGET,
  PLAIN_CLAUSE_BUDGET,
  instantSearchStrictQuery,
  plainQueryLimit,
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
import { SEARCH_LATENCY_BUDGET_MS, stressCases } from "./search-stress-cases";

const index = "feedback-search-perf";

async function main(): Promise<void> {
  const root = await fetch(searchUrl());
  const version = ((await root.json()) as { version?: { number?: string } }).version?.number;
  assert.equal(version, "2.19.5");

  const { bases, docs } = saturatedCorpus();
  await recreateIndex(index);
  try {
    await bulkIndex(index, docs);
    for (const item of stressCases(bases)) {
      const started = performance.now();
      const query =
        item.kind === "plain"
          ? instantSearchStrictQuery(item.query, textSearchAttributes)
          : buildLuceneQueryBody(item.query);
      const buildMs = performance.now() - started;
      if (item.kind === "plain") {
        const limit = plainQueryLimit(item.query);
        assert.ok(
          limit.clauses <= PLAIN_CLAUSE_BUDGET,
          `${item.label} clauses ${limit.clauses} over ${PLAIN_CLAUSE_BUDGET}`,
        );
        assert.ok(
          limit.expansionSlots <= EXPANSION_SLOT_BUDGET,
          `${item.label} expansions ${limit.expansionSlots}`,
        );
        assert.deepEqual(limit.omittedTerms, [], item.label);
      }
      const result = await searchQuery(index, query, 5);
      assert.equal(result.status, 200, `${item.label} ${result.error}`);
      assert.ok(result.took !== null && result.took <= SEARCH_LATENCY_BUDGET_MS, `${item.label} took ${result.took}ms`);
      assert.ok(buildMs < SEARCH_LATENCY_BUDGET_MS, `${item.label} build ${buildMs.toFixed(1)}ms`);
      const clauses = item.kind === "plain" ? plainQueryLimit(item.query).clauses : "-";
      console.info(`${item.label}\tclauses=${clauses}\ttook=${result.took}ms\tbuild=${buildMs.toFixed(1)}ms`);
    }
  } finally {
    await deleteIndex(index);
  }
  console.info("search perf passed");
}

await main();
