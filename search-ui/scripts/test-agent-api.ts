import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_COMMENT_CHARS,
  AGENT_COMMENT_LIMIT,
  AGENT_DETAILS_CHARS,
  AGENT_SNIPPET_CHARS,
  buildAgentPostBody,
  buildAgentSearchBody,
  FEEDBACK_ORIGIN,
  mapAgentPost,
  mapAgentSearchResponse,
  parseAgentSearchQuery,
  SERVICE_LINK,
} from "../server/agent-api";
import {
  instantSearchStrictQuery,
  textSearchAttributes,
} from "../server/searchkit-config";

const parsed = parseAgentSearchQuery({
  q: " avatar ",
  board: " feature-requests ",
  status: " open ",
  limit: "50",
  page: "2",
});
assert.equal(parsed.ok, true);
if (!parsed.ok) {
  throw new Error("expected ok");
}
assert.deepEqual(parsed.params, {
  q: "avatar",
  board: "feature-requests",
  status: "open",
  limit: 20,
  page: 2,
});

const defaults = parseAgentSearchQuery({});
assert.equal(defaults.ok, true);
if (!defaults.ok) {
  throw new Error("expected ok");
}
assert.deepEqual(defaults.params, { q: "", limit: 10, page: 0 });

assert.deepEqual(parseAgentSearchQuery({ q: ["avatar"] }), {
  ok: false,
  message: "invalid q",
});
assert.deepEqual(parseAgentSearchQuery({ board: { urlName: "bug-reports" } }), {
  ok: false,
  message: "invalid board",
});
const zeroLimit = parseAgentSearchQuery({ limit: "0" });
assert.equal(zeroLimit.ok, true);
if (zeroLimit.ok) {
  assert.equal(zeroLimit.params.limit, 10);
}

const pastWindow = parseAgentSearchQuery({ page: "5000", limit: "20" });
assert.deepEqual(pastWindow, { ok: false, message: "page is past the result window" });

const searchBody = buildAgentSearchBody(parsed.params);
assert.deepEqual(searchBody._source, [
  "post_id",
  "title",
  "urlName",
  "board.urlName",
  "status",
  "score",
  "commentCount",
  "created",
]);
assert.equal(JSON.stringify(searchBody._source).includes("comments"), false);
assert.equal(JSON.stringify(searchBody._source).includes("voters"), false);
assert.equal(searchBody.from, 40);
assert.equal(searchBody.size, 20);
assert.deepEqual(searchBody.sort, [{ _score: "desc" }, { created: "desc" }]);
assert.deepEqual(searchBody.query, {
  bool: {
    must: [instantSearchStrictQuery("avatar", textSearchAttributes)],
    filter: [
      { term: { "board.urlName": "feature-requests" } },
      { term: { status: "open" } },
    ],
  },
});

const newest = buildAgentSearchBody(defaults.params);
assert.deepEqual(newest.sort, [{ created: "desc" }]);
assert.deepEqual(newest.query, { match_all: {} });

const postBody = buildAgentPostBody("bug-reports", "crash-on-load");
assert.deepEqual(postBody.query, {
  bool: {
    filter: [
      { term: { "board.urlName": "bug-reports" } },
      { term: { urlName: "crash-on-load" } },
    ],
  },
});
const postSource = postBody._source as string[];
assert.equal(postSource.includes("voters"), false);
assert.equal(postSource.includes("details"), true);
assert.equal(postSource.includes("comments.value"), true);

const snippet = `${"&lt;em&gt;".repeat(60)}avatar`;
const mapped = mapAgentSearchResponse(
  {
    hits: {
      total: { value: 2, relation: "eq" },
      hits: [
        {
          _source: {
            post_id: "abc",
            title: "Avatar limits",
            urlName: "avatar limits",
            board: { urlName: "feature-requests" },
            status: "open",
            score: 12,
            commentCount: 3,
            created: "2024-01-02T00:00:00.000Z",
          },
          highlight: { details: [snippet] },
        },
      ],
    },
  },
  parsed.params,
);
assert.equal(mapped.nbHits, 2);
assert.equal(mapped.hits.length, 1);
assert.equal(
  mapped.hits[0]?.url,
  `${FEEDBACK_ORIGIN}/feature-requests/p/${encodeURIComponent("avatar limits")}`,
);
assert.equal(mapped.hits[0]?.snippet.length, AGENT_SNIPPET_CHARS);
assert.equal(mapped.hits[0]?.snippet.includes("&lt;"), false);
assert.equal(mapped.hits[0]?.snippet.startsWith("<em>"), true);

const comments = [
  {
    value: "hidden",
    pinned: true,
    deleted: true,
    created: "2024-05-01T00:00:00.000Z",
  },
  {
    value: "private note",
    private: true,
    created: "2024-05-02T00:00:00.000Z",
  },
  {
    value: "internal note",
    internal: true,
    created: "2024-05-03T00:00:00.000Z",
  },
  {
    value: "spam note",
    spam: true,
    created: "2024-05-04T00:00:00.000Z",
  },
  {
    value: "   ",
    created: "2024-05-05T00:00:00.000Z",
  },
  {
    value: "pinned older",
    pinned: true,
    created: "2020-01-01T00:00:00.000Z",
    author: { name: " Ada " },
  },
  ...Array.from({ length: AGENT_COMMENT_LIMIT }, (_, index) => ({
    value: `newer ${index} ${"x".repeat(AGENT_COMMENT_CHARS)}`,
    created: `2024-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    author: { name: "Bob" },
  })),
];

const post = mapAgentPost({
  hits: {
    total: { value: 1, relation: "eq" },
    hits: [
      {
        _source: {
          post_id: "abc",
          title: "Avatar limits",
          urlName: "avatar-limits",
          board: { urlName: "feature-requests" },
          status: "open",
          score: 12,
          commentCount: 40,
          created: "2024-01-02T00:00:00.000Z",
          details: "d".repeat(AGENT_DETAILS_CHARS + 25),
          comments,
        },
      },
    ],
  },
});
assert.ok(post);
assert.equal(post?.detailsTruncated, true);
assert.equal(post?.details?.length, AGENT_DETAILS_CHARS);
assert.equal(post?.comments.length, AGENT_COMMENT_LIMIT);
assert.equal(post?.comments[0]?.pinned, true);
assert.equal(post?.comments[0]?.author, "Ada");
assert.equal(post?.comments[0]?.value, "pinned older");
assert.equal(post?.comments[1]?.value.startsWith("newer 7 "), true);
assert.equal(post?.comments[1]?.valueTruncated, true);
assert.equal(post?.comments[1]?.value.length, AGENT_COMMENT_CHARS);
assert.equal(
  post?.comments.some((comment) => comment.value === "hidden"),
  false,
);

assert.equal(
  mapAgentPost({
    hits: { total: { value: 0, relation: "eq" }, hits: [] },
  }),
  null,
);

assert.match(SERVICE_LINK, /rel="service-desc"/);
assert.match(SERVICE_LINK, /rel="service-doc"/);
assert.match(SERVICE_LINK, /<\/openapi\.json>/);
assert.match(SERVICE_LINK, /<\/openapi\.html>/);

const linkInc = readFileSync(
  new URL("../../deploy/nginx/conf.d/feedback-search-service-link.inc", import.meta.url),
  "utf8",
);
assert.ok(linkInc.includes(`add_header Link '${SERVICE_LINK}' always;`));

for (const name of ["index.html", "openapi.html", "install.html"]) {
  const html = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  assert.match(html, /rel="service-desc"[^>]*href="\/openapi\.json"/);
  assert.match(html, /rel="service-doc"[^>]*href="\/openapi\.html"/);
}

console.info("agent-api tests passed");
