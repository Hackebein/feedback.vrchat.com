/**
 * Worst-case searches measured against OpenSearch 3.9.0.
 * Before the clause and depth caps, saturated fuzzy terms and long camelCase
 * identifiers were slow or returned 500, and a few thousand parentheses threw.
 */

export type StressCase = {
  label: string;
  kind: "plain" | "lucene";
  query: string;
};

/** OpenSearch `took` budget for one search on the fixture index. */
export const SEARCH_LATENCY_BUDGET_MS = 250;

const CAMEL_CHUNKS = ["aa", "Bb", "Cc", "Dd", "Ee", "Ff", "Gg", "Hh"];
const STOP_LETTERS = "bcdfghjklmnpqrstvwxyz";
const SUFFIX_LETTERS = "abcdefghijklmnopqrstuvwxyz";

export type IdentifierPile = { label: string; tokens: string[] };

/** `bOfD` shape: a stop word between two content parts, too short for fuzzy. */
export function stopWordIdentifiers(count: number): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const first = STOP_LETTERS[index % STOP_LETTERS.length] ?? "b";
    const second = STOP_LETTERS[Math.floor(index / STOP_LETTERS.length) % STOP_LETTERS.length] ?? "b";
    tokens.push(`${first}Of${second.toUpperCase()}`);
  }
  return tokens;
}

/** Camel identifiers with a stable part count. The suffix stays inside the last part. */
export function camelIdentifiers(parts: number, count: number): string[] {
  const body = CAMEL_CHUNKS.slice(0, parts).join("");
  const tokens: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const first = SUFFIX_LETTERS[Math.floor(index / SUFFIX_LETTERS.length)] ?? "a";
    const second = SUFFIX_LETTERS[index % SUFFIX_LETTERS.length] ?? "a";
    const suffix = `${first}${second}`;
    tokens.push(`${body.slice(0, -1)}${suffix}${body.slice(-1)}`);
  }
  return tokens;
}

export function identifierPiles(): IdentifierPile[] {
  return [
    { label: "stop-word identifiers", tokens: stopWordIdentifiers(24) },
    { label: "three-part identifiers", tokens: camelIdentifiers(3, 40) },
    { label: "four-part identifiers", tokens: camelIdentifiers(4, 40) },
    { label: "eight-part identifiers", tokens: camelIdentifiers(8, 20) },
    {
      label: "mixed identifiers",
      tokens: [
        ...stopWordIdentifiers(8),
        ...camelIdentifiers(3, 8),
        ...camelIdentifiers(4, 8),
        ...camelIdentifiers(8, 4),
      ],
    },
  ];
}

const SYNONYMS =
  "full body tracking fbt face tracking ft frame rate fps vrchat plus avatar performance creator companion open sound control two factor authentication role play";

export function stressCases(bases: readonly string[]): StressCase[] {
  const humps = Array.from({ length: 128 }, (_, index) => (index % 2 === 0 ? "ab" : "Cd")).join("");
  return [
    { label: "plain short", kind: "plain", query: "groupIds" },
    {
      label: "plain saturated fuzzy",
      kind: "plain",
      query: bases.slice(0, 8).join(" "),
    },
    {
      label: "plain many short",
      kind: "plain",
      query: Array.from({ length: 80 }, (_, index) => `zz${index}`).join(" "),
    },
    {
      label: "plain many synonyms",
      kind: "plain",
      query: `${SYNONYMS} ${SYNONYMS} ${SYNONYMS} ${SYNONYMS}`,
    },
    { label: "plain long input", kind: "plain", query: "avatar ".repeat(400) },
    { label: "plain deep humps", kind: "plain", query: humps },
    {
      label: "lucene many wildcards",
      kind: "lucene",
      query: Array.from({ length: 12 }, (_, index) => `tokEn${index}*`).join(" OR "),
    },
    {
      label: "lucene many fuzzy",
      kind: "lucene",
      query: bases.slice(0, 8).map((word) => `${word}~1`).join(" OR "),
    },
    {
      label: "lucene deep nesting",
      kind: "lucene",
      query: `${"(".repeat(5000)}status:open${")".repeat(5000)}`,
    },
    {
      label: "lucene unbounded range",
      kind: "lucene",
      query: "score:[10 TO *] OR score:[* TO 10]",
    },
  ];
}
