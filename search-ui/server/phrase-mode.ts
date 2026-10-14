/**
 * Quoted phrases prefer the `text_phrase` analyzer on `.phrase` subfields.
 * That analyzer is absent until the alias swap. Compatible mode uses
 * `text_index`, which both mappings define and which does not expand synonyms.
 * A missing analyzer retries that one request. The next request tries
 * `text_phrase` again.
 */

export type PhraseMode = "strict" | "compatible";

/** OpenSearch: `[multi_match] analyzer [text_phrase] not found`. */
export function phraseAnalyzerMissing(detail: string | undefined): boolean {
  return typeof detail === "string" && detail.includes("analyzer [text_phrase]");
}

export function phraseAnalyzer(mode: PhraseMode = "strict"): string {
  switch (mode) {
    case "strict":
      return "text_phrase";
    case "compatible":
      return "text_index";
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

const FIELD_BOOST = /^(.*?)(\^[0-9]+(?:\.[0-9]+)?)?$/;

export function phraseSearchFields(
  fields: readonly string[],
  mode: PhraseMode = "strict",
): string[] {
  switch (mode) {
    case "strict":
      return fields.map((field) => {
        const match = FIELD_BOOST.exec(field);
        const name = match?.[1] ?? field;
        const boost = match?.[2] ?? "";
        return `${name}.phrase${boost}`;
      });
    case "compatible":
      return [...fields];
    default: {
      const unreachable: never = mode;
      return unreachable;
    }
  }
}

/**
 * Try strict phrases. If OpenSearch rejects `text_phrase`, run the same
 * request once in compatible mode. Nothing is remembered for the next request.
 */
export async function withPhraseFallback<T>(
  run: (mode: PhraseMode) => Promise<T>,
  detailOf: (error: unknown) => string | undefined,
): Promise<T> {
  try {
    return await run("strict");
  } catch (error) {
    if (!phraseAnalyzerMissing(detailOf(error))) {
      throw error;
    }
    return run("compatible");
  }
}

type PhraseRetryResult = {
  ok: boolean;
  httpStatus?: number;
  detail?: string;
};

/** Same retry as `withPhraseFallback` for callers that return a 400 result. */
export async function withPhraseResultFallback<T extends PhraseRetryResult>(
  run: (mode: PhraseMode) => Promise<T>,
): Promise<T> {
  const first = await run("strict");
  if (first.ok || first.httpStatus !== 400 || !phraseAnalyzerMissing(first.detail)) {
    return first;
  }
  return run("compatible");
}
