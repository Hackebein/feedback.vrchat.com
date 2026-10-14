/**
 * Quoted phrases prefer the `text_phrase` analyzer on `.phrase` subfields.
 * That analyzer is absent until the alias swap, and the gateway can restart
 * first. A query that names it then returns HTTP 400. Compatible mode uses
 * `text_index`, which both mappings define and which does not expand synonyms.
 */

export type PhraseMode = "strict" | "compatible";

let mode: PhraseMode = "strict";

export function phraseMode(): PhraseMode {
  return mode;
}

export function useCompatiblePhrases(): void {
  mode = "compatible";
}

export function resetPhraseMode(): void {
  mode = "strict";
}

/** OpenSearch: `[multi_match] analyzer [text_phrase] not found`. */
export function phraseAnalyzerMissing(detail: string | undefined): boolean {
  return typeof detail === "string" && detail.includes("analyzer [text_phrase]");
}

export function phraseAnalyzer(): string {
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

export function phraseSearchFields(fields: readonly string[]): string[] {
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
 * Run a search once. If OpenSearch rejects `text_phrase`, switch to
 * compatible mode and run again so the rebuilt query omits that analyzer.
 */
export async function withPhraseFallback<T>(
  run: () => Promise<T>,
  detailOf: (error: unknown) => string | undefined,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (phraseMode() !== "strict" || !phraseAnalyzerMissing(detailOf(error))) {
      throw error;
    }
    useCompatiblePhrases();
    return run();
  }
}

type PhraseRetryResult = {
  ok: boolean;
  httpStatus?: number;
  detail?: string;
};

/** Same retry as `withPhraseFallback` for callers that return a 400 result. */
export async function withPhraseResultFallback<T extends PhraseRetryResult>(
  run: () => Promise<T>,
): Promise<T> {
  const first = await run();
  if (
    first.ok ||
    first.httpStatus !== 400 ||
    phraseMode() !== "strict" ||
    !phraseAnalyzerMissing(first.detail)
  ) {
    return first;
  }
  useCompatiblePhrases();
  return run();
}
