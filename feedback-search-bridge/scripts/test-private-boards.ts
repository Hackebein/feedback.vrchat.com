import assert from "node:assert/strict";
import {
  privateBoardSlugs,
  readCannyBoards,
} from "../src/core/private-boards";

assert.deepEqual(
  privateBoardSlugs(
    ["feature-requests", "internal", "bug-reports", "internal"],
    new Set(["feature-requests", "bug-reports"]),
  ),
  ["internal"],
);

assert.deepEqual(
  privateBoardSlugs(["feature-requests"], new Set(["feature-requests"])),
  [],
);

assert.deepEqual(privateBoardSlugs(["  sellers  ", ""], new Set()), ["sellers"]);

const target = {
  __data: {
    boards: {
      items: {
        a: { urlName: "internal", name: "Internal Roadmap Posts", _id: "1" },
        b: { urlName: "feature-requests", name: "Feature Requests", _id: "2" },
        c: { urlName: "internal", name: "Dup", _id: "3" },
        d: { urlName: "  ", name: "No slug" },
      },
    },
  },
} as unknown as Window & typeof globalThis;

assert.deepEqual(readCannyBoards(target), [
  { slug: "internal", name: "Internal Roadmap Posts", id: "1" },
  { slug: "feature-requests", name: "Feature Requests", id: "2" },
]);

console.info("private-boards tests passed");
