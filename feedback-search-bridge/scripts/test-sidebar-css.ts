import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/core/filter-sidebar.ts"),
  "utf8",
);

assert.match(source, /#\$\{PANEL_ID\} \.vrcfb-list\s*\{[^}]*max-height:\s*14rem/);
assert.match(source, /#\$\{PANEL_ID\} \.vrcfb-list\s*\{[^}]*overflow:\s*auto/);
assert.match(
  source,
  /@media \(min-width: 821px\) \{[\s\S]*?overflow:\s*visible !important;/,
);
assert.match(
  source,
  /@media \(min-width: 821px\) \{[\s\S]*?max-height:\s*none !important;/,
);

const outsideDesktop = source.replace(
  /@media \(min-width: 821px\) \{[\s\S]*?\n\s*\}/,
  "",
);
assert.equal(outsideDesktop.includes("overflow: visible"), false);
assert.equal(outsideDesktop.includes("max-height: none"), false);

console.info("sidebar css tests passed");
