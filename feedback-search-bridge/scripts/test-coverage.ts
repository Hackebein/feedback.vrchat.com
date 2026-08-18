import assert from "node:assert/strict";
import {
  isCreatePagePath,
  isLocationCoveredPath,
  isPostDetailPath,
  unionCoveredSlugs,
} from "../src/core/coverage";

assert.equal(isPostDetailPath("/feature-requests/p/some-post"), true);
assert.equal(isPostDetailPath("/feature-requests"), false);
assert.equal(isPostDetailPath("/feature-requests/create"), false);
assert.equal(isPostDetailPath("/"), false);

assert.equal(isCreatePagePath("/feature-requests/create"), true);
assert.equal(isCreatePagePath("/bug-reports/create"), true);
assert.equal(isCreatePagePath("/feature-requests"), false);
assert.equal(isCreatePagePath("/feature-requests/p/some-post"), false);
assert.equal(isCreatePagePath("/"), false);

const indexed = new Set(["feature-requests", "bug-reports"]);

assert.equal(isLocationCoveredPath("/", indexed), true);
assert.equal(isLocationCoveredPath("/feature-requests", indexed), true);
assert.equal(isLocationCoveredPath("/bug-reports", indexed), true);
assert.equal(isLocationCoveredPath("/feature-requests/p/some-post", indexed), false);
assert.equal(isLocationCoveredPath("/feature-requests/create", indexed), false);
assert.equal(isLocationCoveredPath("/bug-reports/create", indexed), false);

// Until coverage loads, board lists stay covered; create and post pages do not.
assert.equal(isLocationCoveredPath("/feature-requests", null), true);
assert.equal(isLocationCoveredPath("/feature-requests/create", null), false);
assert.equal(isLocationCoveredPath("/feature-requests/p/some-post", null), false);

const union = unionCoveredSlugs(
  ["feature-requests", "bug-reports"],
  ["internal", "avatar-marketplace-sellers"],
);
assert.equal(union.has("feature-requests"), true);
assert.equal(union.has("internal"), true);
assert.equal(isLocationCoveredPath("/internal", union), true);
assert.equal(isLocationCoveredPath("/avatar-marketplace-sellers", union), true);
assert.equal(isLocationCoveredPath("/internal/p/some-post", union), false);
assert.equal(isLocationCoveredPath("/unknown-board", union), false);

console.info("coverage tests passed");
