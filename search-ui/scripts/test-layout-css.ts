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
assert.match(facetsBody, /min-width:\s*0/);
assert.match(css, /\.search-layout\s*\{[^}]*height:\s*100dvh/);
assert.match(css, /\.search-layout\s*>\s*\.panels\s*\{[^}]*min-height:\s*0/);
for (const pane of ["facets", "results"]) {
  assert.match(css, new RegExp(`\\.search-layout \\.${pane}\\s*\\{[^}]*overflow-y:\\s*auto`));
  assert.match(css, new RegExp(`\\.search-layout \\.${pane}\\s*\\{[^}]*overscroll-behavior-y:\\s*contain`));
}
assert.match(css, /\.search-layout \.facets\s*\{[^}]*margin-left:\s*calc\(-1 \* var\(--layout-edge\)\)/);

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
