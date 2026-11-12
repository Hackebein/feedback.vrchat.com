export const POST_AUTHOR_FACET = "post_author";
export const NO_AUTHOR_VALUE = "No author";
export const POST_AUTHOR_NAME_PREFIX = "/";

export function postAuthorFacetValue(name: unknown): string {
  // Match Python's str.strip() when deciding whether a name is blank.
  return typeof name === "string" && /[^\p{White_Space}\u001c-\u001f]/u.test(name)
    ? `${POST_AUTHOR_NAME_PREFIX}${name}`
    : NO_AUTHOR_VALUE;
}

export function postAuthorFacetLabel(value: string): string {
  return value.startsWith(POST_AUTHOR_NAME_PREFIX)
    ? value.slice(POST_AUTHOR_NAME_PREFIX.length)
    : value;
}
