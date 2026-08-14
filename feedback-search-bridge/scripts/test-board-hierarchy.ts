import assert from "node:assert/strict";
import {
  filterNestedBoardNodes,
  nestBoardFacetEntries,
} from "../src/core/board-hierarchy";

const nested = nestBoardFacetEntries([
  { value: "Feature Requests", count: 20 },
  { value: "In-Client Bug Reporting", count: 5 },
  { value: "Bug Reports", count: 100 },
  { value: "Android", count: 8 },
]);

assert.deepEqual(
  nested.map((node) => node.value),
  ["Feature Requests", "Bug Reports", "Android"],
);
const bugReports = nested.find((node) => node.value === "Bug Reports");
assert.ok(bugReports);
assert.deepEqual(bugReports.children, [
  { value: "In-Client Bug Reporting", count: 5 },
]);

const parentOnly = nestBoardFacetEntries([{ value: "Bug Reports", count: 100 }]);
assert.deepEqual(parentOnly[0].children, [
  { value: "In-Client Bug Reporting", count: 0 },
]);

const orphanChild = nestBoardFacetEntries([
  { value: "In-Client Bug Reporting", count: 5 },
  { value: "Android", count: 8 },
]);
assert.equal(orphanChild[0].value, "Android");
assert.equal(orphanChild[1].value, "Bug Reports");
assert.equal(orphanChild[1].count, 0);
assert.deepEqual(orphanChild[1].children, [
  { value: "In-Client Bug Reporting", count: 5 },
]);

const filteredChild = filterNestedBoardNodes(nested, "in-client");
assert.deepEqual(
  filteredChild.map((node) => node.value),
  ["Bug Reports"],
);
assert.deepEqual(filteredChild[0].children, [
  { value: "In-Client Bug Reporting", count: 5 },
]);

const filteredParent = filterNestedBoardNodes(nested, "bug");
assert.deepEqual(
  filteredParent.map((node) => node.value),
  ["Bug Reports"],
);
assert.equal(filteredParent[0].children.length, 1);

assert.equal(filterNestedBoardNodes(nested, "nope").length, 0);

console.info("board-hierarchy tests passed");
