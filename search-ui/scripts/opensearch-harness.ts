import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { textSearchAttributes } from "../server/searchkit-config";

const mappingPath = join(dirname(fileURLToPath(import.meta.url)), "../../deploy/opensearch/index_mappings.json");

export function searchUrl(): string {
  return (process.env.OPENSEARCH_URL ?? "http://127.0.0.1:9200").replace(/\/$/, "");
}

export type SearchHitResult = {
  status: number;
  took: number | null;
  ranks: string[];
  error: string;
};

export async function recreateIndex(name: string): Promise<void> {
  const root = searchUrl();
  await fetch(`${root}/${name}`, { method: "DELETE" });
  const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as unknown;
  const created = await fetch(`${root}/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mapping),
  });
  if (!created.ok) {
    throw new Error(`create ${name} ${created.status} ${(await created.text()).slice(0, 400)}`);
  }
}

export async function deleteIndex(name: string): Promise<void> {
  await fetch(`${searchUrl()}/${name}`, { method: "DELETE" });
}

export async function bulkIndex(
  name: string,
  docs: ReadonlyArray<Record<string, unknown> & { post_id: string }>,
): Promise<void> {
  const bulk: string[] = [];
  for (const doc of docs) {
    bulk.push(JSON.stringify({ index: { _id: doc.post_id } }));
    bulk.push(JSON.stringify(doc));
  }
  bulk.push("");
  const response = await fetch(`${searchUrl()}/${name}/_bulk?refresh=true`, {
    method: "POST",
    headers: { "content-type": "application/x-ndjson" },
    body: bulk.join("\n"),
  });
  const text = await response.text();
  if (!response.ok || text.includes('"errors":true')) {
    throw new Error(`bulk ${name} ${response.status} ${text.slice(0, 400)}`);
  }
}

export async function searchQuery(
  name: string,
  query: unknown,
  size = 50,
): Promise<SearchHitResult> {
  const started = performance.now();
  const response = await fetch(`${searchUrl()}/${name}/_search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      size,
      _source: ["post_id"],
      query,
      sort: [{ _score: "desc" }, { created: "desc" }],
    }),
  });
  const text = await response.text();
  let took: number | null = null;
  let ranks: string[] = [];
  if (response.ok) {
    const json = JSON.parse(text) as {
      took?: number;
      hits?: { hits?: Array<{ _score?: number; _source?: { post_id?: string } }> };
    };
    took = json.took ?? null;
    ranks = (json.hits?.hits ?? []).map((hit) => `${hit._source?.post_id ?? ""}@${hit._score ?? 0}`);
  }
  return {
    status: response.status,
    took: response.ok ? took : null,
    ranks,
    error: response.ok ? "" : text.slice(0, 300),
  };
}

export async function analyzeTokens(name: string, analyzer: string, text: string): Promise<string[]> {
  const response = await fetch(`${searchUrl()}/${name}/_analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ analyzer, text }),
  });
  if (!response.ok) {
    throw new Error(`analyze ${response.status} ${(await response.text()).slice(0, 200)}`);
  }
  const json = (await response.json()) as { tokens?: Array<{ token: string }> };
  return (json.tokens ?? []).map((token) => token.token);
}

function searchedField(attribute: (typeof textSearchAttributes)[number]): string {
  return typeof attribute === "string" ? attribute : attribute.field;
}

function oneEditVariants(token: string, alphabet: string): string[] {
  const variants = [token];
  for (let pos = 0; pos < token.length; pos += 1) {
    for (const ch of alphabet) {
      if (token[pos] === ch) {
        continue;
      }
      variants.push(`${token.slice(0, pos)}${ch}${token.slice(pos + 1)}`);
    }
  }
  return variants;
}

function filledDoc(
  postId: string,
  text: string,
): Record<string, unknown> & { post_id: string } {
  const doc: Record<string, unknown> & { post_id: string } = {
    post_id: postId,
    status: "open",
    created: "2020-01-01T00:00:00.000Z",
  };
  for (const attribute of textSearchAttributes) {
    assignField(doc, searchedField(attribute), text);
  }
  return doc;
}

function assignField(doc: Record<string, unknown>, path: string, value: string): void {
  const parts = path.split(".");
  let cursor = doc;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index] ?? "";
    const next = cursor[key];
    if (!next || typeof next !== "object") {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] ?? ""] = value;
}

/**
 * Words that fill a fuzzy expansion on this index, plus one-edit neighbors.
 * Every field in {@link textSearchAttributes} gets the same token, including
 * nested `author.name`. An empty field does not spend `max_expansions`, so a
 * budget measured on a partial document undercounts the rewrite.
 */
export function saturatedCorpus(): { bases: string[]; docs: Array<Record<string, unknown> & { post_id: string }> } {
  const bases = [..."abcdefghijklmnop"].map((letter) => `base${letter}token`);
  const titles = bases.flatMap((base) => oneEditVariants(base, "aeioux"));
  const docs = titles.map((title, index) => filledDoc(`rich-${index}`, title));
  return { bases, docs };
}

/**
 * One document per token. Fuzzy-eligible tokens also carry one-edit neighbors
 * on every searched field, enough to fill `max_expansions`.
 */
export function fieldSaturatedDocs(
  tokens: readonly string[],
  prefix = "ident",
): Array<Record<string, unknown> & { post_id: string }> {
  return tokens.map((token, index) => {
    const words = token.length >= 5 ? oneEditVariants(token, "abcdefghijklmnopqrstuvwxyz") : [token];
    return filledDoc(`${prefix}-${index}`, words.join(" "));
  });
}

function listed(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Leaf count of a rewritten explanation. `#FieldExistsQuery` is an OpenSearch wrapper, not a planned clause. */
export function countExplanationLeaves(explanation: string): number {
  let body = explanation.replace(/#FieldExistsQuery\s*\[[^\]]*\]/g, " ");
  let leaves = 0;
  leaves += body.match(/MatchNoDocsQuery/g)?.length ?? 0;
  body = body.replace(/MatchNoDocsQuery(?:\([^)]*\))?/g, " ");
  leaves += body.match(/Synonym\(/g)?.length ?? 0;
  body = body.replace(/Synonym\([^)]*\)/g, " ");
  for (const match of body.matchAll(/or\(([^)]*)\)/g)) {
    leaves += listed(match[1] ?? "").length;
  }
  body = body.replace(/or\([^)]*\)/g, " ");
  for (const match of body.matchAll(/\b(?:UNORDERED|ORDERED|PHRASE)\(([^)]*)\)/g)) {
    leaves += listed(match[1] ?? "").length;
  }
  body = body.replace(/\b(?:UNORDERED|ORDERED|PHRASE)\([^)]*\)/g, " ");
  leaves += body.match(/"[^"]*"/g)?.length ?? 0;
  body = body.replace(/"[^"]*"/g, " ");
  for (const term of body.match(/[A-Za-z0-9_.]+:[A-Za-z0-9_]+/g) ?? []) {
    if (term.includes("MAXGAPS")) {
      continue;
    }
    leaves += 1;
  }
  return leaves;
}

export async function rewrittenClauseCount(name: string, query: unknown): Promise<number> {
  const response = await fetch(`${searchUrl()}/${name}/_validate/query?explain=true&rewrite=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`validate ${name} ${response.status} ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text) as { explanations?: Array<{ explanation?: string }> };
  const explanation = json.explanations?.[0]?.explanation;
  if (!explanation) {
    throw new Error(`validate ${name} missing explanation ${text.slice(0, 300)}`);
  }
  return countExplanationLeaves(explanation);
}
