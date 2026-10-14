/**
 * Worst-case searches measured against OpenSearch 2.19.5.
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
  ];
}
