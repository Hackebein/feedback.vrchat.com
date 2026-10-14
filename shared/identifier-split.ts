import { ENGLISH_STOP } from "./english-stop";

/**
 * Same boundaries as the index `word_delimiter_graph` and the `camel_boundary`
 * char filter: a lower-to-upper change, and a letter/number change.
 * `XMLHttpRequest` stays `XMLHttp` + `Request`. An all-caps run such as
 * `HTTPResponse` stays one token. Content parts drop stop words. `phraseParts`
 * keeps a stop word that sits between content parts so “end of line” matches
 * and a different word in that hole (“end the line”) does not.
 */
export function splitSearchIdentifier(token: string): { parts: string[]; phraseParts: string[] } {
  const raw = token
    .replace(/(?<=\p{Ll})(?=\p{Lu})/gu, " ")
    .replace(/(?<=\p{L})(?=\p{N})/gu, " ")
    .replace(/(?<=\p{N})(?=\p{L})/gu, " ")
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const contentAt: number[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (!ENGLISH_STOP.has((raw[index] ?? "").toLowerCase())) {
      contentAt.push(index);
    }
  }
  const parts = contentAt.map((index) => raw[index] ?? "");
  if (contentAt.length < 2) {
    return { parts, phraseParts: [] };
  }
  const span = raw.slice(contentAt[0], contentAt[contentAt.length - 1]! + 1);
  const phraseParts = span.some((part) => ENGLISH_STOP.has(part.toLowerCase())) ? span : [];
  return { parts, phraseParts };
}
