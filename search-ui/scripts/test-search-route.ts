import assert from "node:assert/strict";
import qs from "qs";
import {
  FEEDBACK_INDEX,
  RANGE_ATTRS,
  REFINEMENT_LIST_ATTRS,
  TOGGLE_ATTRS,
  rangesFromRoute,
  refinementListsFromRoute,
  routeParamToSortBy,
  sortByToRouteParam,
  togglesFromRoute,
} from "../src/searchRoute";

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

console.info("search route tests passed");
