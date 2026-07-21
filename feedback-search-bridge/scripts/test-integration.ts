import assert from "node:assert/strict";
import {
  mapCannyToGateway,
  mapGatewayToCanny,
} from "../src/core/mapping";

const cannyBody = {
  textSearch: "avatar",
  boardURLNames: ["feature-requests"],
  currentBoard: "feature-requests",
  pages: 1,
  status: "",
  sort: "",
};

const { url, requestBody } = mapCannyToGateway(cannyBody, false);
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify(requestBody),
});

assert.equal(response.ok, true, `gateway returned ${response.status}`);
const gateway = await response.json();
const mapped = mapGatewayToCanny(gateway);

assert.ok(Array.isArray(mapped.result?.posts));
assert.ok((mapped.result?.posts?.length ?? 0) > 0);
assert.equal(typeof mapped.result?.hasNextPage, "boolean");
assert.ok(mapped.result?.posts?.[0]?._id);
assert.ok(mapped.result?.posts?.[0]?.title);

console.info(
  `integration test passed (${mapped.result?.posts?.length} posts mapped)`,
);
