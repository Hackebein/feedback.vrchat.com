import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/index.css"),
  "utf8",
);

function mediaBlock(header: RegExp): string {
  const start = header.exec(css);
  assert.ok(start, `missing media ${header}`);
  const open = css.indexOf("{", start.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") {
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  assert.fail(`unclosed media ${header}`);
}

const facets = /\.facets\s*\{([^}]*)\}/.exec(css);
assert.ok(facets, "missing .facets rule");
const facetsBody = facets[1] ?? "";
assert.match(facetsBody, /position:\s*sticky/);
assert.match(facetsBody, /top:\s*1rem/);
assert.match(facetsBody, /align-self:\s*start/);
assert.doesNotMatch(facetsBody, /overflow\s*:/);
assert.doesNotMatch(facetsBody, /max-height\s*:/);

const desktopBody = mediaBlock(/@media\s*\(\s*min-width:\s*821px\s*\)/);
const desktopFacets = /\.facets\s*\{([^}]*)\}/.exec(desktopBody);
assert.ok(desktopFacets, "desktop .facets rule missing");
const desktopFacetsBody = desktopFacets[1] ?? "";
assert.match(desktopFacetsBody, /max-height:\s*calc\(100vh - 2rem\)/);
assert.match(desktopFacetsBody, /overflow-y:\s*auto/);
assert.match(desktopFacetsBody, /overscroll-behavior:\s*contain/);
assert.match(desktopFacetsBody, /margin-left:\s*-1rem/);
assert.match(desktopFacetsBody, /padding-left:\s*1rem/);
assert.match(desktopFacetsBody, /width:\s*calc\(100% \+ 1rem\)/);
assert.match(desktopBody, /\.facets-toolbar\s*\{[^}]*position:\s*sticky/);
assert.match(desktopBody, /\.facets-toolbar\s*\{[^}]*top:\s*0/);

const mobileBody = mediaBlock(/@media\s*\(\s*max-width:\s*820px\s*\)/);
const mobileFacets = /\.facets\s*\{([^}]*)\}/.exec(mobileBody);
assert.ok(mobileFacets, "mobile .facets rule missing");
const mobileFacetsBody = mobileFacets[1] ?? "";
assert.match(mobileFacetsBody, /position:\s*static/);
assert.doesNotMatch(mobileFacetsBody, /overflow\s*:/);
assert.doesNotMatch(mobileFacetsBody, /margin-left\s*:/);
assert.match(mobileBody, /\.facets-drawer\s*\{[^}]*overflow-y:\s*auto/);

assert.match(css, /\.ais-RefinementList-list\s*\{[^}]*max-height:\s*14rem/);
assert.match(css, /\.ais-RefinementList-list\s*\{[^}]*overflow:\s*auto/);

console.info("layout css tests passed");
