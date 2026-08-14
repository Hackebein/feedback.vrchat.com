import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, "dist");

const userscriptBanner = `// ==UserScript==
// @name         VRChat Feedback: gateway search
// @namespace    https://github.com/hackebein/feedback.vrchat.com
// @version      1.0.8
// @description  Replace feedback.vrchat.com search with vrchat-canny.hackebein.dev OpenSearch gateway
// @author       feedback.vrchat.com
// @homepageURL  https://github.com/hackebein/feedback.vrchat.com
// @supportURL   https://github.com/hackebein/feedback.vrchat.com/issues
// @updateURL    https://vrchat-canny.hackebein.dev/feedback.vrchat.com.user.js
// @downloadURL  https://vrchat-canny.hackebein.dev/feedback.vrchat.com.user.js
// @match        https://feedback.vrchat.com/*
// @match        https://vrchat-canny.hackebein.dev/install.html
// @connect      vrchat-canny.hackebein.dev
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==
`;

await esbuild.build({
  bundle: true,
  format: "iife",
  target: "es2020",
  legalComments: "none",
  entryPoints: [join(__dirname, "src/userscript/entry.ts")],
  outfile: join(dist, "feedback.vrchat.com.user.js"),
  banner: { js: userscriptBanner },
});

console.info("Built feedback-search-bridge:");
console.info(`  ${join(dist, "feedback.vrchat.com.user.js")}`);
