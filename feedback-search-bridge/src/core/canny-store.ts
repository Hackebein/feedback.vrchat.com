import type { CannySearchResponse } from "./types";

type ReduxStore = {
  dispatch: (action: unknown) => unknown;
  getState: () => Record<string, unknown>;
};

const POST_QUERIES_INVALIDATE = "canny/post_queries/invalidate";
const POSTS_LOADED = "canny/posts/posts_loaded";
const QUERY_LOADED = "canny/post_queries/query_loaded";

function findStoreFromFiber(fiber: Record<string, unknown> | null): ReduxStore | null {
  while (fiber) {
    const props = fiber.memoizedProps as Record<string, unknown> | undefined;
    const propsStore = props?.store;
    if (
      propsStore &&
      typeof (propsStore as ReduxStore).dispatch === "function" &&
      typeof (propsStore as ReduxStore).getState === "function"
    ) {
      return propsStore as ReduxStore;
    }

    const stateNode = fiber.stateNode as Record<string, unknown> | null;
    const nodeStore = stateNode?.store;
    if (
      nodeStore &&
      typeof (nodeStore as ReduxStore).dispatch === "function" &&
      typeof (nodeStore as ReduxStore).getState === "function"
    ) {
      return nodeStore as ReduxStore;
    }

    fiber = (fiber.return as Record<string, unknown> | null) ?? null;
  }
  return null;
}

function findStoreFromElement(element: Element): ReduxStore | null {
  const host = element as unknown as Record<string, unknown>;
  const fiberKey = Object.keys(host).find(
    (key) =>
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$"),
  );
  if (!fiberKey) {
    return null;
  }

  return findStoreFromFiber(host[fiberKey] as Record<string, unknown>);
}

export function getCannyReduxStore(
  target: Window & typeof globalThis,
): ReduxStore | null {
  const roots = [
    target.document.getElementById("content"),
    target.document.getElementById("details"),
    target.document.body,
  ].filter(
    (node): node is HTMLElement =>
      !!node &&
      typeof node === "object" &&
      "children" in node &&
      typeof node.children.length === "number",
  );

  for (const root of roots) {
    const stack: Element[] = [root];
    let visited = 0;

    while (stack.length > 0 && visited < 250) {
      const node = stack.pop()!;
      visited += 1;

      const store = findStoreFromElement(node);
      if (store) {
        return store;
      }

      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index]!);
      }
    }
  }

  return null;
}

export function invalidateCannyPostQueries(
  target: Window & typeof globalThis,
): boolean {
  const store = getCannyReduxStore(target);
  if (!store) {
    return false;
  }

  store.dispatch({
    type: POST_QUERIES_INVALIDATE,
    timestamp: Date.now(),
  });
  return true;
}

function parsePostQueryKey(key: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Canny keys are JSON.stringify(queryParams); ignore anything else.
  }
  return null;
}

function readPostQueryMap(postQueries: unknown): Record<string, unknown> | null {
  if (!postQueries || typeof postQueries !== "object" || Array.isArray(postQueries)) {
    return null;
  }
  const record = postQueries as Record<string, unknown>;
  const items = record.items;
  if (items && typeof items === "object" && !Array.isArray(items)) {
    return items as Record<string, unknown>;
  }
  return record;
}

/**
 * Canny's list is bound to the postQueries entry created by its own search
 * request (typically `sort: "relevance"`). Reuse that exact key so a sidebar
 * sort/filter refresh updates the visible list instead of writing a miss.
 */
export function findLiveSearchQueryParams(
  store: ReduxStore | null,
  textSearch: string,
): Record<string, unknown> | null {
  const needle = textSearch.trim();
  if (!store || !needle) {
    return null;
  }

  const map = readPostQueryMap(store.getState().postQueries);
  if (!map) {
    return null;
  }

  let fallback: Record<string, unknown> | null = null;
  for (const key of Object.keys(map)) {
    const parsed = parsePostQueryKey(key);
    if (!parsed) {
      continue;
    }
    const keySearch =
      typeof parsed.textSearch === "string" ? parsed.textSearch.trim() : "";
    if (keySearch !== needle) {
      continue;
    }
    if (parsed.sort === "relevance") {
      return parsed;
    }
    fallback = parsed;
  }
  return fallback;
}

export function applyCannySearchResults(
  store: ReduxStore,
  queryParams: Record<string, unknown>,
  cannyResponse: CannySearchResponse,
): void {
  const posts = cannyResponse.result?.posts ?? [];
  const timestamp = Date.now();
  const result = {
    posts,
    hasNextPage: cannyResponse.result?.hasNextPage ?? false,
  };

  if (posts.length > 0) {
    store.dispatch({
      type: POSTS_LOADED,
      posts,
      timestamp,
    });
  }

  // Always write the query slot, including an empty posts array, so a
  // zero-hit filter combination clears the list instead of leaving stale rows.
  store.dispatch({
    type: QUERY_LOADED,
    queryParams,
    result,
    timestamp,
  });
}

export type { ReduxStore };
