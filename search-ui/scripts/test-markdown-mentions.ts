import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../src/MarkdownText";

function render(source: string, highlightTerms?: string[]): string {
  return renderToStaticMarkup(createElement(MarkdownText, { source, highlightTerms }));
}

assert.match(
  render("Thanks (@_tau_), @__beta__, and @dev_team_!"),
  /<p>Thanks \(@_tau_\), @__beta__, and @dev_team_!<\/p>/,
);
assert.match(
  render("_Italic_, __bold__, *@_tau_*, and `@_tau_`"),
  /<em>Italic<\/em>, <strong>bold<\/strong>, <em>@_tau_<\/em>, and <code>@_tau_<\/code>/,
);
assert.match(
  render("[@_tau_](https://example.com/@_tau_) and contact@example.com"),
  /href="https:\/\/example\.com\/@_tau_"[^>]*>@_tau_<\/a> and <a [^>]*href="mailto:contact@example\.com"/,
);
assert.match(render("Thanks @_tau_!", ["_tau_"]), /@<mark>_tau_<\/mark>!/);

console.info("Markdown mention tests passed");
