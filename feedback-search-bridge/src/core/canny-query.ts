import { getSort, hasActiveFilters } from "./filter-state";
import type { CannySearchBody } from "./types";

function decodeSearchParam(raw: string): string {
  let value = raw.replace(/\+/g, " ");
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) {
        break;
      }
      value = decoded;
    } catch {
      break;
    }
  }
  return value.trim();
}

function readSearchParam(raw: string | null): string {
  if (!raw) {
    return "";
  }
  return decodeSearchParam(raw);
}

function readBoardSlug(pathname: string): string | null {
  const slug = pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  if (!slug || slug === "admin" || slug === "search") {
    return null;
  }
  return slug;
}

type BoardLike = { urlName?: string; _id?: string; name?: string };

type ReduxStore = {
  getState: () => Record<string, unknown>;
};

/** Sort string Canny uses as the postQueries key while a text search is active. */
export const CANNY_SEARCH_SORT = "relevance";

/**
 * Redux postQueries key sort: Canny's search list is always keyed by
 * `relevance`, while board browsing uses the sidebar/URL sort.
 */
export function cannyListSortKey(
  textSearch: string,
  sidebarSort: string,
  urlSort = "",
): string {
  if (textSearch.trim()) {
    return CANNY_SEARCH_SORT;
  }
  return sidebarSort.trim() || urlSort.trim();
}

export function readActiveSearchQuery(
  target: Window & typeof globalThis,
): string {
  const url = new URL(target.location.href);
  const fromUrl = readSearchParam(url.searchParams.get("search"));
  if (fromUrl) {
    return fromUrl;
  }

  const input = target.document.querySelector<HTMLInputElement>(
    '.searchContainer input[placeholder="Search…"]',
  );
  return input?.value.trim() ?? "";
}

export function readBoardSlugFromPage(
  target: Window & typeof globalThis,
): string | null {
  return readBoardSlug(new URL(target.location.href).pathname);
}

function readBoardFromState(
  store: ReduxStore | null,
  boardSlug: string | null,
): BoardLike | undefined {
  if (!boardSlug || !store) {
    return undefined;
  }
  const boards = store.getState().boards as
    | { items?: Record<string, BoardLike> }
    | undefined;
  return boards?.items?.[boardSlug];
}

export function buildPostQueryParams(
  target: Window & typeof globalThis,
  store: ReduxStore | null,
): Record<string, unknown> | null {
  const textSearch = readActiveSearchQuery(target);
  const boardSlug = readBoardSlugFromPage(target);

  // The bridge now drives every list view, so a refresh is meaningful whenever
  // there is a text query, a board context, or any active sidebar filter.
  if (!textSearch && !boardSlug && !hasActiveFilters()) {
    return null;
  }

  const url = new URL(target.location.href);
  const board =
    readBoardFromState(store, boardSlug) ??
    (boardSlug ? { urlName: boardSlug } : undefined);

  const params: Record<string, unknown> = { textSearch };
  if (board) {
    params.currentBoard = board;
  }

  const sort = cannyListSortKey(
    textSearch,
    getSort(),
    url.searchParams.get("sort") ?? "",
  );
  if (sort) {
    params.sort = sort;
  }

  return params;
}

export function buildCannySearchBody(
  target: Window & typeof globalThis,
  queryParams: Record<string, unknown>,
): CannySearchBody {
  const textSearch = String(queryParams.textSearch ?? "").trim();
  const board = queryParams.currentBoard as BoardLike | undefined;
  const boardSlug = board?.urlName ?? readBoardSlugFromPage(target) ?? undefined;

  const body: CannySearchBody = {
    __host: "feedback.vrchat.com",
    textSearch,
    pages:
      typeof queryParams.pages === "number" && Number.isFinite(queryParams.pages)
        ? Math.trunc(queryParams.pages)
        : 1,
    status: "",
  };

  if (boardSlug) {
    body.currentBoard = boardSlug;
  }

  const sort = queryParams.sort;
  if (typeof sort === "string" && sort.trim()) {
    body.sort = sort.trim();
  }

  return body;
}

export function triggerSearchViaHistory(
  target: Window & typeof globalThis,
  query: string,
): void {
  const encoded = encodeURIComponent(query);

  const navigate = (searchValue: string | null): void => {
    const next = new URL(target.location.href);
    if (searchValue) {
      next.searchParams.set("search", searchValue);
    } else {
      next.searchParams.delete("search");
    }
    const nextUrl = next.toString();
    if (nextUrl === target.location.href) {
      return;
    }
    target.history.replaceState(target.history.state, "", nextUrl);
    target.dispatchEvent(new PopStateEvent("popstate", { bubbles: true }));
  };

  navigate(null);
  target.setTimeout(() => navigate(encoded), 50);
}

export function syncSearchInputValue(
  target: Window & typeof globalThis,
  query: string,
): void {
  const input = target.document.querySelector<HTMLInputElement>(
    '.searchContainer input[placeholder="Search…"]',
  );
  if (!input || input.value === query) {
    return;
  }

  const prototype = Object.getPrototypeOf(input) as HTMLInputElement;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (valueSetter) {
    valueSetter.call(input, query);
  } else {
    input.value = query;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
