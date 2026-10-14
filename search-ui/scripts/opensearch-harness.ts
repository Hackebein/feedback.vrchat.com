import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Words that fill a fuzzy expansion on this index, plus one-edit neighbors. */
export function saturatedCorpus(): { bases: string[]; docs: Array<Record<string, unknown> & { post_id: string }> } {
  const alphabet = "abcdefghijklmnop";
  const bases = [...alphabet].map((letter) => `base${letter}token`);
  const titles: string[] = [];
  for (const base of bases) {
    titles.push(base);
    for (let pos = 0; pos < base.length; pos += 1) {
      for (const ch of ["a", "e", "i", "o", "u", "x"]) {
        if (base[pos] === ch) {
          continue;
        }
        titles.push(`${base.slice(0, pos)}${ch}${base.slice(pos + 1)}`);
      }
    }
  }
  const docs = titles.map((title, index) => ({
    post_id: `rich-${index}`,
    title,
    details: title,
    combined_text: title,
    status: "open",
    created: "2020-01-01T00:00:00.000Z",
  }));
  return { bases, docs };
}
