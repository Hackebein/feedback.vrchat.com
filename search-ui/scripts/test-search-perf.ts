/**
 * CI check for worst-case search latency and clause count.
 * The longer table is `npm run bench:search` in search-ui.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import API from "@searchkit/api";
import { buildLuceneQueryBody } from "../server/lucene-query";
import {
  FUZZY_CLAUSE_BUDGET,
  OPENSEARCH_MAX_CLAUSE_COUNT,
  PLAIN_CLAUSE_BUDGET,
  degradedPlainQuery,
  fuzzyExpansionLimit,
  instantSearchStrictQuery,
  plainQueryLimit,
  rejectTooManyNestedClauses,
  retryWithoutNestedClauses,
  searchkitConfig,
  textSearchAttributes,
} from "../server/searchkit-config";
import {
  bulkIndex,
  deleteIndex,
  fieldSaturatedDocs,
  recreateIndex,
  rewrittenClauseCount,
  saturatedCorpus,
  searchQuery,
  searchUrl,
} from "./opensearch-harness";
import { SEARCH_LATENCY_BUDGET_MS, identifierPiles, stopWordIdentifiers, stressCases } from "./search-stress-cases";

const index = "feedback-search-perf";

function valueAt(doc: unknown, path: string): unknown {
  let cursor = doc;
  for (const part of path.split(".")) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function searchedField(attribute: (typeof textSearchAttributes)[number]): string {
  return typeof attribute === "string" ? attribute : attribute.field;
}

function fuzzyTerms(query: unknown): Array<{ text: string; expansions: number }> {
  const found: Array<{ text: string; expansions: number }> = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const multi = (value as { multi_match?: unknown }).multi_match;
    if (multi && typeof multi === "object") {
      const body = multi as { query?: unknown; fuzziness?: unknown; max_expansions?: unknown };
      if (body.fuzziness === "AUTO:5,100" && typeof body.query === "string" && typeof body.max_expansions === "number") {
        found.push({ text: body.query, expansions: body.max_expansions });
      }
    }
    for (const child of Object.values(value as Record<string, unknown>)) walk(child);
  };
  walk(query);
  return found;
}

async function main(): Promise<void> {
  const root = await fetch(searchUrl());
  const version = ((await root.json()) as { version?: { number?: string } }).version?.number;
  assert.equal(version, "3.9.0");

  const { bases, docs } = saturatedCorpus();
  const sample = docs[0];
  assert.ok(sample);
  for (const attribute of textSearchAttributes) {
    assert.equal(valueAt(sample, searchedField(attribute)), bases[0], searchedField(attribute));
  }
  assert.ok(OPENSEARCH_MAX_CLAUSE_COUNT - FUZZY_CLAUSE_BUDGET >= 256);

  await recreateIndex(index);
  try {
    await bulkIndex(index, docs);
    const stored = (await (await fetch(`${searchUrl()}/${index}/_doc/${sample.post_id}`)).json()) as {
      _source?: unknown;
    };
    for (const attribute of textSearchAttributes) {
      const path = searchedField(attribute);
      assert.equal(valueAt(stored._source, path), bases[0], path);
    }

    const worstTerms = bases.slice(0, 8);
    const worstQueryText = worstTerms.join(" ");
    const worstLimit = plainQueryLimit(worstQueryText);
    const worstExpansions = fuzzyExpansionLimit(worstTerms.length);
    assert.ok(worstExpansions >= 1);
    assert.ok(worstLimit.clauses <= FUZZY_CLAUSE_BUDGET, `worst clauses ${worstLimit.clauses}`);
    assert.deepEqual(worstLimit.omittedTerms, []);
    const worstBuilt = instantSearchStrictQuery(worstQueryText, textSearchAttributes);
    const worstFuzzy = fuzzyTerms(worstBuilt);
    for (const term of worstTerms) {
      assert.ok(
        worstFuzzy.some((item) => item.text === term && item.expansions === worstExpansions),
        term,
      );
    }
    const worstResult = await searchQuery(index, worstBuilt, 5);
    assert.equal(worstResult.status, 200, worstResult.error);

    const piles = identifierPiles();
    const pileTokens = [...new Set(piles.flatMap((pile) => pile.tokens))];
    await bulkIndex(index, fieldSaturatedDocs(pileTokens, "ident"));
    for (const pile of piles) {
      const text = pile.tokens.join(" ");
      const limit = plainQueryLimit(text);
      const built = instantSearchStrictQuery(text, textSearchAttributes);
      const actual = await rewrittenClauseCount(index, built);
      assert.ok(limit.clauses <= PLAIN_CLAUSE_BUDGET, `${pile.label} ${limit.clauses}`);
      assert.ok(limit.clauses >= actual, `${pile.label} estimate ${limit.clauses} actual ${actual}`);
      assert.ok(actual > 0, pile.label);
      const result = await searchQuery(index, built, 1);
      assert.equal(result.status, 200, `${pile.label} ${result.error}`);
      console.info(`${pile.label}\tclauses=${limit.clauses}\tactual=${actual}`);
    }

    const fatTokens = stopWordIdentifiers(30);
    const fat = {
      bool: { must: fatTokens.map((token) => instantSearchStrictQuery(token, textSearchAttributes)) },
    };
    const fatResult = await searchQuery(index, fat, 1);
    assert.equal(fatResult.status, 400, fatResult.error);
    assert.equal(fatResult.error.includes("too_many_nested_clauses"), true);
    const gateway = API(searchkitConfig(searchUrl(), "admin", "admin"));
    let attempts = 0;
    const recovered = await retryWithoutNestedClauses(false, (degraded) => {
      attempts += 1;
      return gateway.handleRequest(
        [{ indexName: index, params: { query: fatTokens.join(" "), hitsPerPage: 1 } }],
        {
          getQuery: () =>
            degraded ? degradedPlainQuery(fatTokens.join(" "), textSearchAttributes) : fat,
          hooks: {
            afterSearch: async (_requests, responses) => rejectTooManyNestedClauses(responses),
          },
        },
      );
    });
    assert.equal(attempts, 2);
    const recoveredResult = recovered.results[0];
    assert.ok(recoveredResult && "hits" in recoveredResult, "degraded retry should return hits");
    const degradedBuilt = degradedPlainQuery(fatTokens.join(" "), textSearchAttributes);
    const degradedActual = await rewrittenClauseCount(index, degradedBuilt);
    const degradedEstimate = plainQueryLimit(fatTokens.join(" "), textSearchAttributes, true).clauses;
    assert.ok(degradedEstimate >= degradedActual, `${degradedEstimate} < ${degradedActual}`);
    const degradedResult = await searchQuery(index, degradedBuilt, 1);
    assert.equal(degradedResult.status, 200, degradedResult.error);

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
        if (item.label === "plain saturated fuzzy") {
          assert.ok(
            limit.clauses <= FUZZY_CLAUSE_BUDGET,
            `${item.label} clauses ${limit.clauses} over ${FUZZY_CLAUSE_BUDGET}`,
          );
        }
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
