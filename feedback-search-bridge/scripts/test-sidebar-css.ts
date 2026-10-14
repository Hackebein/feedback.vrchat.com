import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/core/filter-sidebar.ts"),
  "utf8",
);

function mediaBlock(header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing media ${header}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  assert.fail(`unclosed media ${header}`);
}

assert.match(source, /#\$\{PANEL_ID\} \.vrcfb-list\s*\{[^}]*max-height:\s*14rem/);
assert.match(source, /#\$\{PANEL_ID\} \.vrcfb-list\s*\{[^}]*overflow:\s*auto/);

const desktopBody = mediaBlock("@media (min-width: 821px) {");
assert.match(
  desktopBody,
  /\.sidebarContainerWrapper\s*\{[^}]*max-height:\s*calc\(100vh - 32px\) !important;/,
);
assert.match(desktopBody, /\.sidebarContainerWrapper\s*\{[^}]*overflow-y:\s*auto !important;/);
assert.match(
  desktopBody,
  /\.sidebarContainerWrapper\s*\{[^}]*overscroll-behavior:\s*contain !important;/,
);
assert.match(desktopBody, /\.boardDetails\s*\{[^}]*max-height:\s*none !important;/);
assert.match(desktopBody, /\.boardDetails\s*\{[^}]*overflow:\s*visible !important;/);
assert.match(desktopBody, /\.sidebarContainer\s*\{[^}]*max-height:\s*none !important;/);
assert.match(desktopBody, /\.sidebarContainer\s*\{[^}]*overflow:\s*visible !important;/);

const paddedBody = mediaBlock("@media (min-width: 821px) and (max-width: 1020px) {");
assert.match(paddedBody, /margin-left:\s*-32px !important;/);
assert.match(paddedBody, /padding-left:\s*32px !important;/);
assert.match(paddedBody, /width:\s*calc\(300px \+ 32px\) !important;/);

const outsideDesktop = source
  .replace(desktopBody, "")
  .replace(paddedBody, "");
assert.equal(outsideDesktop.includes("overflow: visible"), false);
assert.equal(outsideDesktop.includes("max-height: none"), false);
assert.equal(outsideDesktop.includes("overflow-y: auto"), false);

console.info("sidebar css tests passed");
