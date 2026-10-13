import assert from "node:assert/strict";
import {
  FEEDBACK_INDEX,
  routeParamToSortBy,
  sortByToRouteParam,
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

console.info("search route tests passed");
