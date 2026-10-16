import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAnalyticsService } from "../server/analytics-api";
import { createSearchService } from "../server/search-service";
import { createIndexGenerationResolver } from "../server/index-generation";

const base = process.env.OPENSEARCH_URL ?? "http://127.0.0.1:9200";
const password = process.env.OPENSEARCH_INITIAL_ADMIN_PASSWORD;
assert.ok(password, "Set OPENSEARCH_INITIAL_ADMIN_PASSWORD for the test container");
const alias = `analytics-security-test-${process.pid}`;
const index = `${alias}-202610160000`;
const user = `${alias}-reader`;
const readerPassword = "Analytics_Readonly_7!pK3";
const auth = (name: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${name}:${secret}`).toString("base64")}`, "Content-Type": "application/json" });
async function admin(path: string, method = "GET", body?: unknown, contentType = "application/json") {
  const response = await fetch(`${base}${path}`, { method, headers: { ...auth("admin", password!), "Content-Type": contentType }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok && response.status !== 404) console.error(`OpenSearch ${response.status}: ${(await response.clone().text()).slice(0, 1800)}`);
  return response;
};
try {
  const bootstrap = readFileSync(new URL("../../deploy/scripts/bootstrap_security.sh", import.meta.url), "utf8");
  const roleBlock = bootstrap.split('os_put "/_plugins/_security/api/roles/${PROXY_USER}-readonly"')[1]!.split("\nJSON")[0]!;
  const role = JSON.parse(roleBlock.slice(roleBlock.indexOf("{" )).replaceAll("${OS_INDEX_ALIAS}", alias).replaceAll("${OS_BACKING_PATTERN}", `${alias}-*`));
  await admin(`/_plugins/_security/api/roles/${user}`, "PUT", role);
  await admin(`/_plugins/_security/api/internalusers/${user}`, "PUT", { password: readerPassword, backend_roles: [] });
  await admin(`/_plugins/_security/api/rolesmapping/${user}`, "PUT", { users: [user], backend_roles: [], hosts: [] });
  const mapping = JSON.parse(readFileSync(new URL("../../deploy/opensearch/index_mappings.json", import.meta.url), "utf8"));
  await admin(`/${index}`, "PUT", mapping);
  const bulk: string[] = [];
  for (let i = 0; i < 610; i++) {
    bulk.push(JSON.stringify({ index: { _id: String(i) } }));
    bulk.push(JSON.stringify({ post_id: String(i), title: "Security test", status: i % 2 ? "tracked" : "open", created: "2020-01-01T00:00:00Z", statusChanged: "2020-01-02T00:00:00Z" }));
  }
  const indexed = await admin(`/${index}/_bulk?refresh=true`, "POST", bulk.join("\n") + "\n", "application/x-ndjson");
  assert.equal(indexed.errors, false);
  await admin("/_aliases", "POST", { actions: [{ add: { index, alias } }] });
  // Production explicitly disables server-side scroll contexts.
  await admin("/_cluster/settings", "PUT", { persistent: { "search.max_open_scroll_context": 0 } });
  const target = { opensearchUrl: base, opensearchUser: user, opensearchPassword: readerPassword, index: alias };
  const search = createSearchService(target);
  const resolveIndex = createIndexGenerationResolver({ ...target, alias });
  const analytics = createAnalyticsService({ target, resolveIndex, compile: search.compile });
  const empty = await analytics({ facetFilters: ["status:missing"] }, false);
  assert.equal(empty.total, 0);
  const report = await analytics({}, false);
  assert.equal(report.total, 610);
  assert.equal(report.current.find(row => row.status === "tracked")?.count, 305);
  const denied = await originalFetch(`${base}/${index}/_doc/forbidden`, { method: "PUT", headers: auth(user, readerPassword), body: JSON.stringify({ post_id: "forbidden" }) });
  assert.equal(denied.status, 403, "gateway must remain read-only");
  console.info("analytics passes with production security role, scripts disabled, and multiple pages");
} finally {
  globalThis.fetch = originalFetch;
  await admin(`/${index}`, "DELETE").catch(() => undefined);
  for (const kind of ["rolesmapping", "internalusers", "roles"]) await admin(`/_plugins/_security/api/${kind}/${user}`, "DELETE").catch(() => undefined);
}
