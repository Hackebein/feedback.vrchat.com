import assert from "node:assert/strict";
import qs from "qs";
import { NO_AUTHOR_VALUE, POST_AUTHOR_FACET, postAuthorFacetValue } from "../../shared/post-author-facet";
import {
  FEEDBACK_INDEX,
  RANGE_ATTRS,
  REFINEMENT_LIST_ATTRS,
  TOGGLE_ATTRS,
  rangesFromRoute,
  refinementListsFromRoute,
  refinementListsToRoute,
  routeParamToSortBy,
  sortByToRouteParam,
  togglesFromRoute,
} from "../src/searchRoute";
import { getCurrentSearchParams, setCurrentSearchParams } from "../src/searchFilterStore";

const relevance = `${FEEDBACK_INDEX}_relevance_desc`;

assert.equal(routeParamToSortBy(undefined, true), relevance);
assert.equal(routeParamToSortBy(undefined, false), undefined);
assert.equal(routeParamToSortBy("newest", true), FEEDBACK_INDEX);
assert.equal(routeParamToSortBy("relevance_desc", true), relevance);
assert.equal(routeParamToSortBy("score_desc", false), `${FEEDBACK_INDEX}_score_desc`);

assert.equal(sortByToRouteParam(relevance, true), undefined);
assert.equal(sortByToRouteParam(undefined, true), undefined);
assert.equal(sortByToRouteParam(FEEDBACK_INDEX, true), "newest");
assert.equal(sortByToRouteParam(FEEDBACK_INDEX, false), undefined);
assert.equal(sortByToRouteParam(`${FEEDBACK_INDEX}_score_desc`, true), "score_desc");

assert.equal(
  sortByToRouteParam(routeParamToSortBy(undefined, true), true),
  undefined,
);
assert.equal(routeParamToSortBy("newest", true), FEEDBACK_INDEX);

const statusFirst = qs.parse(
  "status=open&status=closed&board.name=Bug%20Reports&score=1%3A10&voteSettings.highEngagement=1",
  { arrayLimit: 99 },
);
const boardFirst = qs.parse(
  "voteSettings.highEngagement=1&score=1%3A10&board.name=Bug%20Reports&status=closed&status=open",
  { arrayLimit: 99 },
);
const fromStatus = refinementListsFromRoute(statusFirst, REFINEMENT_LIST_ATTRS);
const fromBoard = refinementListsFromRoute(boardFirst, REFINEMENT_LIST_ATTRS);
assert.deepEqual(Object.keys(fromStatus), Object.keys(fromBoard));
assert.deepEqual(fromStatus.board_name, fromBoard.board_name);
assert.deepEqual([...(fromStatus.status ?? [])].sort(), [...(fromBoard.status ?? [])].sort());
assert.deepEqual(fromStatus.status, ["open", "closed"]);
assert.deepEqual(fromBoard.status, ["closed", "open"]);
assert.deepEqual(rangesFromRoute(statusFirst, RANGE_ATTRS), rangesFromRoute(boardFirst, RANGE_ATTRS));
assert.deepEqual(
  togglesFromRoute(statusFirst, TOGGLE_ATTRS),
  togglesFromRoute(boardFirst, TOGGLE_ATTRS),
);

const namedAuthor = postAuthorFacetValue("No author");
assert.notEqual(namedAuthor, NO_AUTHOR_VALUE);
assert.deepEqual(refinementListsFromRoute(qs.parse("author.name=No%20author"), REFINEMENT_LIST_ATTRS), {
  [POST_AUTHOR_FACET]: [namedAuthor],
});
const authorRoute = refinementListsToRoute({ [POST_AUTHOR_FACET]: [namedAuthor, NO_AUTHOR_VALUE] });
assert.deepEqual(authorRoute, { "author.name": ["No author"], "author.missing": "1" });
assert.deepEqual(refinementListsFromRoute(qs.parse(qs.stringify(authorRoute)), REFINEMENT_LIST_ATTRS), {
  [POST_AUTHOR_FACET]: [namedAuthor, NO_AUTHOR_VALUE],
});
assert.deepEqual(refinementListsFromRoute({ "author.missing": "1" }, REFINEMENT_LIST_ATTRS), {
  [POST_AUTHOR_FACET]: [NO_AUTHOR_VALUE],
});

const namedFilter = `${POST_AUTHOR_FACET}:${namedAuthor}`;
const missingFilter = `${POST_AUTHOR_FACET}:${NO_AUTHOR_VALUE}`;
setCurrentSearchParams({ facetFilters: [[namedFilter], "status:open"] });
assert.deepEqual(getCurrentSearchParams().facetFilters, [["author_name:No author"], "status:open"]);
setCurrentSearchParams({ facetFilters: [[namedFilter, missingFilter]] });
assert.deepEqual(getCurrentSearchParams().facetFilters, [[namedFilter, missingFilter]]);

console.info("search route tests passed");
