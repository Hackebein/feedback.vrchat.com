const CACHE_MS = 2000;

export function createIndexGenerationResolver(opts: {
  opensearchUrl: string;
  opensearchUser: string;
  opensearchPassword: string;
  alias: string;
}): () => Promise<string> {
  const auth =
    "Basic " +
    Buffer.from(`${opts.opensearchUser}:${opts.opensearchPassword}`).toString(
      "base64",
    );
  const mappingUrl = `${opts.opensearchUrl.replace(/\/$/, "")}/${encodeURIComponent(opts.alias)}/_mapping?filter_path=*.mappings.dynamic`;

  let cached: { name: string; until: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function fetchBackingIndex(): Promise<string> {
    const response = await fetch(mappingUrl, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `OpenSearch mapping ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("OpenSearch mapping returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenSearch mapping returned no indices");
    }
    const names = Object.keys(parsed).sort();
    const latest = names[names.length - 1];
    if (!latest) {
      throw new Error("OpenSearch mapping returned no indices");
    }
    return latest;
  }

  return async function resolveIndexGeneration(): Promise<string> {
    const now = Date.now();
    if (cached && cached.until > now) {
      return cached.name;
    }
    if (!inflight) {
      inflight = fetchBackingIndex().finally(() => {
        inflight = null;
      });
    }
    const name = await inflight;
    cached = { name, until: Date.now() + CACHE_MS };
    return name;
  };
}
