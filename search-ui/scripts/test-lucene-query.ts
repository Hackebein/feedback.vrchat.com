import assert from "node:assert/strict";
import { buildLuceneQueryBody, rewriteEnumOr } from "../server/lucene-query";

assert.equal(
  rewriteEnumOr("status:open status:planned author.name:Alice title:avatar"),
  "(status:open OR status:planned) AND author.name:Alice AND title:avatar",
);

assert.equal(
  rewriteEnumOr("voters.name:Alice voters.name:Bob"),
  "voters.name:Alice OR voters.name:Bob",
);

assert.equal(
  rewriteEnumOr('author.name.keyword:"Jane Doe" author.name.keyword:"Alice"'),
  'author.name.keyword:"Jane Doe" OR author.name.keyword:"Alice"',
);

assert.equal(
  rewriteEnumOr("status:open OR status:planned"),
  "status:open OR status:planned",
);

assert.equal(
  rewriteEnumOr("status:open AND status:planned"),
  "status:open OR status:planned",
);

assert.equal(
  rewriteEnumOr("NOT status:open status:planned"),
  "NOT status:open AND status:planned",
);

assert.equal(
  rewriteEnumOr("status:open status:planned score:[10 TO *]"),
  "(status:open OR status:planned) AND score:[10 TO *]",
);

assert.equal(
  rewriteEnumOr("status:(open OR planned)"),
  "status:(open OR planned)",
);

assert.equal(
  rewriteEnumOr("author.name:Alice author.name.keyword:\"Bob\""),
  "author.name:Alice AND author.name.keyword:\"Bob\"",
);

const voters = buildLuceneQueryBody("voters.name:Alice voters.name:Bob");
assert.deepEqual(voters, {
  bool: {
    must: [
      {
        nested: {
          path: "voters",
          query: {
            query_string: {
              query: "voters.name:Alice OR voters.name:Bob",
              default_operator: "AND",
              lenient: true,
              analyze_wildcard: true,
            },
          },
        },
      },
    ],
  },
});

const mixed = buildLuceneQueryBody(
  "status:open status:planned comments.author.name:Alice comments.author.name:Bob",
);
assert.deepEqual(mixed, {
  bool: {
    must: [
      {
        query_string: {
          query: "status:open OR status:planned",
          default_operator: "AND",
          lenient: true,
          analyze_wildcard: true,
          fields: ["combined_text^3", "title^2", "details", "author.name", "aiCategories"],
        },
      },
      {
        nested: {
          path: "comments",
          query: {
            query_string: {
              query: "comments.author.name:Alice OR comments.author.name:Bob",
              default_operator: "AND",
              lenient: true,
              analyze_wildcard: true,
            },
          },
        },
      },
    ],
  },
});

console.info("lucene-query tests passed");
