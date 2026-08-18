import assert from "node:assert/strict";
import { extractPostFromData, parseCannyData } from "../src/core/canny-html";

const html = `<!doctype html><html><head></head><body>
<script>
window.__data = {"viewer":undefined,"posts":{"board1":{"udon-ui":{"_id":"post-1","title":"Udon UI","urlName":"udon-ui","notFound":false}}},"postsActivity":{"post-1":{"comments":{"c1":{"_id":"c1","value":"In backlog","created":"2024-04-09T22:29:22.543Z","author":{"name":"Fax"}},"c0":{"_id":"c0","value":"Earlier","created":"2024-04-09T22:00:00.000Z","deleted":false}}}}};
</script>
</body></html>`;

const data = parseCannyData(html);
assert.ok(data);
assert.equal(data.viewer, null);

const extracted = extractPostFromData(data, "udon-ui");
assert.ok(extracted);
assert.equal(extracted.post._id, "post-1");
assert.equal(extracted.comments.length, 2);
assert.equal(extracted.comments[0]?.value, "Earlier");
assert.equal(extracted.comments[1]?.value, "In backlog");

const missing = extractPostFromData(data, "nope");
assert.equal(missing, null);

const notFoundHtml = `window.__data = {"posts":{"b":{"gone":{"_id":"x","urlName":"gone","notFound":true}}}};`;
const notFound = parseCannyData(notFoundHtml);
assert.ok(notFound);
assert.equal(extractPostFromData(notFound, "gone"), null);

console.info("canny-html tests passed");
