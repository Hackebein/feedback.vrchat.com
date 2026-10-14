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

assert.equal(
  rewriteEnumOr("status:Open status:planned"),
  "status:open OR status:planned",
);
assert.equal(rewriteEnumOr("status:OPEN"), "status:open");
assert.equal(rewriteEnumOr("board.urlName:Bug-Reports"), "board.urlName:bug\\-reports");
assert.equal(rewriteEnumOr("comments.pinned:True"), "comments.pinned:true");
assert.equal(
  rewriteEnumOr("voteSettings.highEngagement:True"),
  "voteSettings.highEngagement:true",
);
assert.equal(rewriteEnumOr("vrc+"), "vrc\\+");
assert.equal(rewriteEnumOr("C++"), "C\\+\\+");
assert.equal(rewriteEnumOr("C#"), "C#");
assert.equal(rewriteEnumOr("http://example.com"), "http\\:\\/\\/example.com");
assert.equal(rewriteEnumOr("title:http://example.com/docs"), "title:http\\:\\/\\/example.com\\/docs");
assert.equal(
  rewriteEnumOr("groupIds~1"),
  "combined_text.exact:groupIds~1 OR title.exact:groupIds~1 OR details.exact:groupIds~1 OR author.name.exact:groupIds~1",
);
assert.equal(rewriteEnumOr("title:groupIds~1"), "title.exact:groupIds~1");
assert.equal(
  rewriteEnumOr("groupIds~"),
  "combined_text.exact:groupIds~ OR title.exact:groupIds~ OR details.exact:groupIds~ OR author.name.exact:groupIds~",
);
assert.equal(rewriteEnumOr("title:avatar^2"), "title:avatar^2");
assert.equal(rewriteEnumOr("+groupIds"), "+groupIds");
assert.equal(rewriteEnumOr("status:(open OR planned)"), "status:(open OR planned)");
assert.equal(rewriteEnumOr("status:(Open OR Closed)"), "status:(open OR closed)");
assert.equal(rewriteEnumOr("status:[Open TO Closed]"), "status:[open TO closed]");
assert.equal(
  rewriteEnumOr("comments.pinned:(True OR False)"),
  "comments.pinned:(true OR false)",
);
assert.equal(rewriteEnumOr('status:("Open" OR "Closed")'), 'status:("open" OR "closed")');
assert.equal(rewriteEnumOr("title:(C++)"), "title:(C++)");
assert.equal(rewriteEnumOr("title:(vrc+)"), "title:(vrc+)");
assert.equal(rewriteEnumOr("score:[10 TO *]"), "score:[10 TO *]");
assert.equal(rewriteEnumOr("(groupIds"), "groupIds");

const escaped = buildLuceneQueryBody("status:Open");
assert.equal(
  (escaped as { query_string: { query: string } }).query_string.query,
  "status:open",
);

const joined = buildLuceneQueryBody("status:open AND title:avatar");
assert.equal(
  (joined as { query_string: { query: string } }).query_string.query,
  "status:open AND title:avatar",
);

const quotedPhrase = buildLuceneQueryBody('"full body tracking"');
assert.deepEqual(quotedPhrase, {
  multi_match: {
    query: "full body tracking",
    type: "phrase",
    fields: ["combined_text^3", "title^2", "details", "author.name"],
    analyzer: "text_phrase",
  },
});

const titlePhrase = buildLuceneQueryBody('title:"full body tracking"');
assert.deepEqual(titlePhrase, {
  multi_match: {
    query: "full body tracking",
    type: "phrase",
    fields: ["title^2"],
    analyzer: "text_phrase",
  },
});

const keywordQuote = buildLuceneQueryBody('status:"Open"');
assert.equal(
  (keywordQuote as { query_string: { query: string } }).query_string.query,
  'status:"open"',
);

console.info("lucene-query tests passed");
