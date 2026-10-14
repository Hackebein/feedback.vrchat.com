import assert from "node:assert/strict";
import { buildLuceneQueryBody, rewriteEnumOr } from "../server/lucene-query";
import {
  phraseAnalyzerMissing,
  phraseMode,
  resetPhraseMode,
  useCompatiblePhrases,
  withPhraseFallback,
  withPhraseResultFallback,
} from "../server/phrase-mode";

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
const exactFuzzyRewrite = (term: string) =>
  `(combined_text.exact:${term} OR title.exact:${term} OR details.exact:${term} OR author.name.exact:${term})`;
assert.equal(rewriteEnumOr("groupIds~1"), exactFuzzyRewrite("groupIds~1"));
assert.equal(rewriteEnumOr("title:groupIds~1"), "title.exact:groupIds~1");
assert.equal(rewriteEnumOr("groupIds~"), exactFuzzyRewrite("groupIds~"));
assert.equal(rewriteEnumOr("groupIds*"), exactFuzzyRewrite("groupIds*"));
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

const groupedOr = buildLuceneQueryBody("status:open AND (title:avatar OR title:merch)");
assert.equal(
  (groupedOr as { query_string: { query: string } }).query_string.query,
  "status:open AND (title:avatar OR title:merch)",
);

const queryString = (query: string) => ({
  query_string: {
    query,
    default_operator: "AND" as const,
    lenient: true,
    analyze_wildcard: true,
    fields: ["combined_text^3", "title^2", "details", "author.name", "aiCategories"],
  },
});

const exactFuzzy = (term: string) => ({
  bool: {
    should: ["combined_text", "title", "details", "author.name"].map((field) =>
      queryString(`${field}.exact:${term}`),
    ),
    minimum_should_match: 1,
  },
});

assert.deepEqual(buildLuceneQueryBody("groupIds~1"), exactFuzzy("groupIds~1"));
assert.deepEqual(buildLuceneQueryBody("groupIds*"), exactFuzzy("groupIds*"));
assert.deepEqual(buildLuceneQueryBody("status:open AND groupIds~1"), {
  bool: { must: [queryString("status:open"), exactFuzzy("groupIds~1")] },
});
assert.deepEqual(buildLuceneQueryBody("groupIds~1 AND status:open"), {
  bool: { must: [exactFuzzy("groupIds~1"), queryString("status:open")] },
});
assert.deepEqual(buildLuceneQueryBody("status:open AND groupIds*"), {
  bool: { must: [queryString("status:open"), exactFuzzy("groupIds*")] },
});
assert.deepEqual(buildLuceneQueryBody("NOT groupIds~1"), {
  bool: { must_not: [exactFuzzy("groupIds~1")] },
});
assert.equal(
  (buildLuceneQueryBody("title:groupIds~1") as { query_string: { query: string } }).query_string
    .query,
  "title.exact:groupIds~1",
);

const phrase = (query: string, fields: string[], analyzer = "text_phrase") => ({
  multi_match: {
    query,
    type: "phrase" as const,
    fields,
    analyzer,
  },
});

const quotedPhrase = buildLuceneQueryBody('"full body tracking"');
assert.deepEqual(
  quotedPhrase,
  phrase("full body tracking", [
    "combined_text.phrase^3",
    "title.phrase^2",
    "details.phrase",
    "author.name.phrase",
  ]),
);

const titlePhrase = buildLuceneQueryBody('title:"full body tracking"');
assert.deepEqual(titlePhrase, phrase("full body tracking", ["title.phrase^2"]));

const keywordQuote = buildLuceneQueryBody('status:"Open"');
assert.equal(
  (keywordQuote as { query_string: { query: string } }).query_string.query,
  'status:"open"',
);

const keywordOr = buildLuceneQueryBody('status:"Open" OR status:"Closed"');
assert.equal(
  (keywordOr as { query_string: { query: string } }).query_string.query,
  'status:"open" OR status:"closed"',
);

assert.deepEqual(buildLuceneQueryBody('status:open AND title:"full body tracking"'), {
  bool: {
    must: [queryString("status:open"), phrase("full body tracking", ["title.phrase^2"])],
  },
});

assert.deepEqual(buildLuceneQueryBody('status:closed OR title:"full body tracking"'), {
  bool: {
    should: [queryString("status:closed"), phrase("full body tracking", ["title.phrase^2"])],
    minimum_should_match: 1,
  },
});

assert.deepEqual(
  buildLuceneQueryBody('status:closed OR (title:"full body tracking" AND avatar)'),
  {
    bool: {
      should: [
        queryString("status:closed"),
        {
          bool: {
            must: [phrase("full body tracking", ["title.phrase^2"]), queryString("avatar")],
          },
        },
      ],
      minimum_should_match: 1,
    },
  },
);

useCompatiblePhrases();
assert.equal(phraseMode(), "compatible");
assert.deepEqual(
  buildLuceneQueryBody('"full body tracking"'),
  phrase(
    "full body tracking",
    ["combined_text^3", "title^2", "details", "author.name"],
    "text_index",
  ),
);
assert.deepEqual(
  buildLuceneQueryBody('title:"full body tracking"'),
  phrase("full body tracking", ["title^2"], "text_index"),
);
resetPhraseMode();
assert.equal(phraseMode(), "strict");
assert.equal(
  phraseAnalyzerMissing("[multi_match] analyzer [text_phrase] not found"),
  true,
);
assert.equal(phraseAnalyzerMissing("failed to parse"), false);
assert.equal(phraseAnalyzerMissing(undefined), false);

let fallbackCalls = 0;
const fallback = await withPhraseFallback(async () => {
  fallbackCalls += 1;
  if (phraseMode() === "strict") {
    throw new Error('{"error":"[multi_match] analyzer [text_phrase] not found"}');
  }
  return buildLuceneQueryBody('"full body tracking"');
}, (error) => (error instanceof Error ? error.message : undefined));
assert.equal(fallbackCalls, 2);
assert.equal(phraseMode(), "compatible");
assert.equal(
  (fallback as { multi_match: { analyzer: string } }).multi_match.analyzer,
  "text_index",
);

resetPhraseMode();
let rejectedCalls = 0;
await assert.rejects(
  () =>
    withPhraseFallback(async () => {
      rejectedCalls += 1;
      throw new Error("parse failure");
    }, () => "parse failure"),
  /parse failure/,
);
assert.equal(rejectedCalls, 1);
assert.equal(phraseMode(), "strict");

let resultCalls = 0;
const retried = await withPhraseResultFallback(async () => {
  resultCalls += 1;
  if (resultCalls === 1) {
    return {
      ok: false as const,
      httpStatus: 400 as const,
      message: "Invalid search query",
      detail: "analyzer [text_phrase] not found",
    };
  }
  return { ok: true as const, body: { hit: 1 } };
});
assert.equal(retried.ok, true);
assert.equal(resultCalls, 2);
assert.equal(phraseMode(), "compatible");

resetPhraseMode();
const unrelated = await withPhraseResultFallback(async () => ({
  ok: false as const,
  httpStatus: 400 as const,
  message: "Invalid search query",
  detail: "failed to parse",
}));
assert.equal(unrelated.ok, false);
assert.equal(phraseMode(), "strict");

console.info("lucene-query tests passed");
