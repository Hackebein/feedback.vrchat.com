import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"),
  "utf8",
);

const facets = /\.facets\s*\{([^}]*)\}/.exec(css);
assert.ok(facets, "missing .facets rule");
const facetsBody = facets[1] ?? "";
assert.match(facetsBody, /position:\s*sticky/);
assert.match(facetsBody, /top:\s*1rem/);
assert.match(facetsBody, /align-self:\s*start/);
assert.doesNotMatch(facetsBody, /overflow\s*:/);
assert.doesNotMatch(facetsBody, /max-height\s*:/);

assert.match(
  css,
  /@media\s*\(\s*min-width:\s*821px\s*\)\s*\{[^]*?\.facets-toolbar\s*\{[^}]*position:\s*sticky/,
);
assert.match(
  css,
  /@media\s*\(\s*max-width:\s*820px\s*\)\s*\{[^]*?\.facets\s*\{[^}]*position:\s*static/,
);
assert.match(css, /\.ais-RefinementList-list\s*\{[^}]*max-height:\s*14rem/);
assert.match(css, /\.ais-RefinementList-list\s*\{[^}]*overflow:\s*auto/);

console.info("layout css tests passed");
