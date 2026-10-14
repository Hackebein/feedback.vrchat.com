import assert from "node:assert/strict";
import {
  additionalFacetCounts,
  buildCombinedText,
  facetsFromPosts,
  filterPrivatePosts,
  mergeFacetCounts,
  mergeSearchHits,
  paginateMergedHits,
  privateMatchScore,
  queryTokens,
  relevanceScore,
  sortHits,
  toStoredPost,
} from "../src/core/private-search";
import type { StoredPrivatePost } from "../src/core/private-store";
import type { CannySearchBody } from "../src/core/types";

function stored(
  partial: Record<string, unknown>,
  boardSlug = "internal",
): StoredPrivatePost {
  const payload = {
    _id: "p1",
    urlName: "post",
    title: "Hello world",
    details: "Avatar performance",
    status: "open",
    score: 10,
    commentCount: 0,
    created: "2024-01-02T00:00:00.000Z",
    board: { name: "Internal Roadmap Posts", urlName: boardSlug },
    author: { name: "Alex" },
    voteSettings: { highEngagement: false, lowEngagement: true, moderateEngagement: false },
    ...partial,
  };
  return toStoredPost(payload, boardSlug);
}

assert.deepEqual(queryTokens("  Avatar   Crash "), ["avatar", "crash"]);
assert.equal(relevanceScore("avatar avatar crash", ["avatar"]), 2);

const internal = stored({
  _id: "a",
  title: "Udon UI",
  details: "Quick menu buttons",
  created: "2024-06-01T00:00:00.000Z",
  score: 3,
  comments: [{ value: "in backlog", author: { name: "Fax" } }],
});
const sellers = stored(
  {
    _id: "b",
    title: "Payout delay",
    details: "Store cashout",
    created: "2024-07-01T00:00:00.000Z",
    score: 20,
    status: "tracked",
    board: { name: "Avatar Marketplace Sellers", urlName: "avatar-marketplace-sellers" },
  },
  "avatar-marketplace-sellers",
);
const older = stored({
  _id: "c",
  title: "Old idea",
  details: "Something else",
  created: "2023-01-01T00:00:00.000Z",
  score: 5,
});

assert.match(buildCombinedText(internal.payload), /in backlog/);

const textBody: CannySearchBody = {
  textSearch: "udon backlog",
  filters: { refinements: {}, ranges: {}, toggles: {}, sort: "newest" },
};
const textHits = filterPrivatePosts([internal, sellers, older], textBody, {
  luceneMode: false,
});
assert.deepEqual(
  textHits.map((post) => post._id),
  ["a"],
);

const boardBody: CannySearchBody = {
  textSearch: "",
  filters: {
    refinements: { board_name: ["Avatar Marketplace Sellers"] },
    ranges: {},
    toggles: {},
    sort: "newest",
  },
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], boardBody, { luceneMode: false }).map(
    (post) => post._id,
  ),
  ["b"],
);
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], boardBody, {
    luceneMode: false,
    ignoreBoard: true,
  }).map((post) => post._id).sort(),
  ["a", "b", "c"],
);

const rangeBody: CannySearchBody = {
  textSearch: "",
  filters: {
    refinements: {},
    ranges: { score: { min: 10 } },
    toggles: {},
    sort: "score_desc",
  },
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], rangeBody, { luceneMode: false }).map(
    (post) => post._id,
  ),
  ["b"],
);

const luceneBody: CannySearchBody = {
  textSearch: "payout",
  filters: boardBody.filters,
};
assert.deepEqual(
  filterPrivatePosts([internal, sellers, older], luceneBody, { luceneMode: true }).map(
    (post) => post._id,
  ),
  ["b"],
);

const gatewayHits = [
  {
    _id: "g1",
    title: "Public",
    created: "2024-05-01T00:00:00.000Z",
    score: 1,
  },
];
const mergedNewest = mergeSearchHits(
  gatewayHits,
  [internal, sellers, older],
  "newest",
  "",
);
assert.deepEqual(
  mergedNewest.map((hit) => hit._id),
  ["b", "a", "g1", "c"],
);

const page0 = paginateMergedHits(mergedNewest, 0, 2);
assert.deepEqual(
  page0.posts.map((hit) => hit._id),
  ["b", "a"],
);
assert.equal(page0.hasNextPage, true);
const page1 = paginateMergedHits(mergedNewest, 1, 2);
assert.deepEqual(
  page1.posts.map((hit) => hit._id),
  ["g1", "c"],
);
assert.equal(page1.hasNextPage, false);

const scoreMerged = mergeSearchHits(gatewayHits, [internal, sellers], "score_desc", "");
assert.equal(scoreMerged[0]?._id, "b");

const localFacets = facetsFromPosts([internal, sellers]);
assert.equal(localFacets.facets.board_name?.["Internal Roadmap Posts"], 1);
assert.equal(localFacets.facets.status?.open, 1);
assert.equal(localFacets.stats.score?.max, 20);

assert.deepEqual(
  mergeFacetCounts(
    { board_name: { "Feature Requests": 10 } },
    { board_name: { "Internal Roadmap Posts": 2, "Feature Requests": 1 } },
  ).board_name,
  { "Feature Requests": 11, "Internal Roadmap Posts": 2 },
);

const votedByBoth = stored({
  _id: "ab",
  voters: [{ name: "Alice" }, { name: "Bob" }],
});
const votedByBob = stored({
  _id: "bo",
  voters: [{ name: "Bob" }],
});
const voterAdditional = additionalFacetCounts(
  [votedByBoth, votedByBob],
  {
    textSearch: "",
    filters: {
      refinements: { voter_name: ["Alice"] },
      ranges: {},
      toggles: {},
      sort: "newest",
    },
  },
  false,
);
assert.equal(voterAdditional.voter_name?.Bob, 1);
assert.equal(voterAdditional.voter_name?.Alice, undefined);

const groupIdsPost = stored({
  _id: "group-ids",
  title: "Expose groupIds",
  details: "The groupIds field is missing from the response",
  status: "open",
});
const groupWordsPost = stored({
  _id: "group-words",
  title: "Group lobbies",
  details: "Filter the lobby by group rank",
  status: "open",
});
const groupIdWordsPost = stored({
  _id: "group-id-words",
  title: "Show the group ids",
  details: "Print group ids on the profile card",
  status: "open",
});
const gropIdsPost = stored({
  _id: "grop-ids",
  title: "gropIds typo",
  details: "Someone wrote gropIds in the notes",
  status: "open",
});
const fullBodyPost = stored({
  _id: "full-body",
  title: "Add full body tracking",
  details: "full body tracking for avatars",
  status: "open",
});
const reversedBodyPost = stored({
  _id: "reversed-body",
  title: "Tracking body is full",
  details: "the body comes before full here",
  status: "closed",
});
const closedPost = stored({
  _id: "closed-avatar",
  title: "Closed avatar idea",
  details: "avatar idea that shipped",
  status: "closed",
});

const identifierPosts = [
  groupIdsPost,
  groupWordsPost,
  groupIdWordsPost,
  gropIdsPost,
  fullBodyPost,
  reversedBodyPost,
  closedPost,
];

function idsFor(textSearch: string, luceneMode: boolean): string[] {
  return filterPrivatePosts(identifierPosts, { textSearch }, { luceneMode }).map(
    (post) => post._id,
  );
}

assert.deepEqual(idsFor("groupIds", false).sort(), ["grop-ids", "group-id-words", "group-ids"]);
assert.equal(idsFor("groupIds", false).includes("group-words"), false);
const groupIdsRanked = sortHits(
  [groupWordsPost.payload, gropIdsPost.payload, groupIdWordsPost.payload, groupIdsPost.payload],
  "relevance",
  "groupIds",
);
assert.equal(groupIdsRanked[0]?._id, "group-ids");
assert.deepEqual(idsFor("gropIds", false).sort(), ["grop-ids", "group-ids"]);
assert.deepEqual(idsFor('"full body"', false), ["full-body"]);
assert.deepEqual(idsFor("status:Open", true), ["group-ids", "group-words", "group-id-words", "grop-ids", "full-body"]);
assert.deepEqual(idsFor("status:closed", true).sort(), ["closed-avatar", "reversed-body"]);
assert.deepEqual(idsFor('title:"full body"', true), ["full-body"]);
assert.deepEqual(idsFor("status:open AND NOT status:closed", true).includes("closed-avatar"), false);
assert.deepEqual(idsFor("board.urlName:Internal", true).length > 0, true);

const ranked = sortHits(
  [groupWordsPost.payload, gropIdsPost.payload, groupIdsPost.payload],
  "relevance",
  "gropIds",
);
assert.equal(ranked[0]?._id, "grop-ids");
assert.equal(ranked[1]?._id, "group-ids");

function rankPrivate(
  posts: StoredPrivatePost[],
  query: string,
  luceneMode = false,
): string[] {
  return posts
    .map((post) => ({ id: post._id, score: privateMatchScore(post.payload, query, luceneMode) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((row) => `${row.id}@${row.score}`);
}

function assertSamePrivate(label: string, queries: string[], luceneMode = false): void {
  const ranks = queries.map((query) => rankPrivate(identifierPosts, query, luceneMode));
  assert.ok(ranks[0] && ranks[0].length > 0, `${label}: expected hits`);
  for (const rank of ranks.slice(1)) {
    assert.deepEqual(rank, ranks[0], label);
  }
}

assert.equal(privateMatchScore(groupIdWordsPost.payload, "groupIds"), 40);
assertSamePrivate("terms", ["group ids", "ids group"]);
assert.deepEqual(rankPrivate(identifierPosts, "status:open AND title:group"), []);
assertSamePrivate(
  "fields",
  ["status:open board.urlName:internal", "board.urlName:internal status:open"],
  true,
);
assertSamePrivate("and", ["status:open AND title:group", "title:group AND status:open"], true);
assertSamePrivate(
  "lowercase and",
  ["status:open and title:group", "title:group AND status:open"],
  true,
);
assertSamePrivate("or", ["status:open OR status:closed", "status:closed OR status:open"], true);
assertSamePrivate(
  "precedence",
  ["title:avatar AND status:open OR status:closed", "status:closed OR status:open AND title:avatar"],
  true,
);
assertSamePrivate("not", ["avatar NOT status:closed", "NOT status:closed AND avatar"], true);
assertSamePrivate("mixed phrase", ['avatar "full body"', '"full body" avatar']);

const notePost = stored({
  _id: "note",
  title: "See note: the bug is here",
  details: "func() crashes when opened",
  status: "open",
});
const workingPost = stored({
  _id: "working",
  title: "Menu does not load",
  details: "not working",
  status: "open",
});
const quietPost = stored({
  _id: "quiet",
  title: "Avatar loads",
  details: "nothing about the menu",
  status: "open",
});
assert.ok(privateMatchScore(notePost.payload, "note: bug") > 0);
assert.ok(privateMatchScore(notePost.payload, "func()") > 0);
assert.ok(privateMatchScore(workingPost.payload, "NOT working") > 0);
assert.ok(privateMatchScore(workingPost.payload, "not working") > 0);
assert.equal(privateMatchScore(workingPost.payload, "NOT working", true), 0);
assert.ok(privateMatchScore(quietPost.payload, "NOT working", true) > 0);
const plainNot = sortHits(
  [quietPost.payload, workingPost.payload],
  "relevance",
  "NOT working",
);
assert.equal(plainNot[0]?._id, "working");
assert.ok(privateMatchScore(workingPost.payload, "NOT working") > 0);
const luceneNot = sortHits(
  [workingPost.payload, quietPost.payload],
  "relevance",
  "NOT working",
  undefined,
  true,
);
assert.equal(luceneNot[0]?._id, "quiet");
const quotedPrivate = rankPrivate(identifierPosts, '"full body"');
const quotedPrivateReverse = rankPrivate(identifierPosts, '"body full"');
assert.notDeepEqual(quotedPrivate, quotedPrivateReverse);
assert.equal(quotedPrivate.some((row) => row.startsWith("full-body@")), true);
assert.equal(quotedPrivateReverse.some((row) => row.startsWith("full-body@")), false);

function filteredIds(refinements: Record<string, string[]>): string[] {
  return filterPrivatePosts(
    identifierPosts,
    {
      textSearch: "group",
      filters: { refinements, ranges: {}, toggles: {}, sort: "relevance" },
    },
    { luceneMode: false },
  )
    .map((post) => `${post._id}@${privateMatchScore(post.payload, "group")}`)
    .sort();
}

assert.deepEqual(
  filteredIds({ status: ["open", "closed"], board_name: ["Internal Roadmap Posts"] }),
  filteredIds({ board_name: ["Internal Roadmap Posts"], status: ["closed", "open"] }),
);

const farPost = stored({
  _id: "group-far",
  title: "group",
  details: "sentence two has ids",
});
assert.equal(privateMatchScore(farPost.payload, "groupIds"), 0);
assert.ok(privateMatchScore(farPost.payload, "group ids") > 0);

const endLinePost = stored({ _id: "end-line", title: "end line", details: "wrapped" });
const endOfPost = stored({ _id: "end-of", title: "end of line", details: "wrapped" });
const endFooPost = stored({ _id: "end-foo", title: "end foo line", details: "hole" });
assert.ok(privateMatchScore(endLinePost.payload, "endOfLine") > 0);
assert.ok(privateMatchScore(endOfPost.payload, "endOfLine") > 0);
assert.equal(privateMatchScore(endFooPost.payload, "endOfLine"), 0);
assert.equal(
  privateMatchScore(stored({ _id: "group-of", title: "group of ids", details: "gap" }).payload, "groupIds"),
  0,
);
assert.equal(
  privateMatchScore(stored({ _id: "end-the", title: "end the line", details: "other stop" }).payload, "endOfLine"),
  0,
);
assert.ok(
  privateMatchScore(stored({ _id: "xml-pair", title: "XMLHttp Request", details: "pair" }).payload, "XMLHttpRequest") > 0,
);
assert.equal(
  privateMatchScore(
    stored({ _id: "xml-spaced", title: "XML Http Request", details: "spaced" }).payload,
    "XMLHttpRequest",
  ),
  0,
);
assert.equal(
  privateMatchScore(stored({ _id: "http-spaced", title: "HTTP Response", details: "spaced" }).payload, "HTTPResponse"),
  0,
);
assert.ok(
  privateMatchScore(
    stored({ _id: "simple-pair", title: "simple xmlparser", details: "pair" }).payload,
    "simpleXMLParser",
  ) > 0,
);
assert.equal(
  privateMatchScore(
    stored({ _id: "simple-spaced", title: "simple XML parser", details: "spaced" }).payload,
    "simpleXMLParser",
  ),
  0,
);
assert.ok(privateMatchScore(endFooPost.payload, "end of line") > 0);

const menuPost = stored({
  _id: "menu",
  title: "Menu does not load",
  details: "not working",
});
const zebraPost = stored({ _id: "zebra", title: "Zebra stable", details: "unrelated" });
assert.ok(privateMatchScore(menuPost.payload, "the menu") > 0);
assert.equal(privateMatchScore(zebraPost.payload, "the menu"), 0);
assert.deepEqual(
  filterPrivatePosts([menuPost, zebraPost], { textSearch: "the" }, { luceneMode: false })
    .map((post) => post._id)
    .sort(),
  ["menu", "zebra"],
);
privateMatchScore(menuPost.payload, `${"(".repeat(5000)}menu`, true);
assert.equal(
  privateMatchScore(menuPost.payload, "menu the"),
  privateMatchScore(menuPost.payload, "the menu"),
);

console.info("private-search tests passed");
