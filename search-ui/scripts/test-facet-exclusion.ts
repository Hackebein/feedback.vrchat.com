import assert from "node:assert/strict";
import type { SearchRequest } from "searchkit";
import { applyExcludeFacets, excludeFacetClause } from "../server/facet-exclusion";

assert.deepEqual(excludeFacetClause("status", ["open"]), {
  term: { status: "open" },
});

assert.deepEqual(excludeFacetClause("voter_name", ["Alice", "Bob"]), {
  nested: {
    path: "voters",
    query: {
      bool: {
        should: [
          { term: { "voters.name.keyword": "Alice" } },
          { term: { "voters.name.keyword": "Bob" } },
        ],
        minimum_should_match: 1,
      },
    },
  },
});

const requests = applyExcludeFacets([
  {
    indexName: "feedback-posts",
    request: {
      indexName: "feedback-posts",
      params: {
        excludeFacet: { attribute: "status", values: ["open", "planned"] },
      },
    },
    body: {
      query: {
        bool: {
          filter: [{ term: { "board.name.keyword": "Bug Reports" } }],
          must: { match_all: {} },
        },
      },
    },
  },
] as unknown as SearchRequest[]);

const filter = requests[0]?.body.query?.bool?.filter;
assert.ok(Array.isArray(filter));
assert.deepEqual(filter[1], {
  bool: {
    must_not: [
      {
        bool: {
          should: [{ term: { status: "open" } }, { term: { status: "planned" } }],
          minimum_should_match: 1,
        },
      },
    ],
  },
});

console.info("facet-exclusion tests passed");
