export type CannyBoard = {
  slug: string;
  name: string;
  id: string;
};

type BoardItem = {
  urlName?: string;
  name?: string;
  _id?: string;
};

function readBoardItems(
  target: Window & typeof globalThis,
): Record<string, BoardItem> | null {
  const items = (
    target as unknown as {
      __data?: { boards?: { items?: Record<string, BoardItem> } };
    }
  ).__data?.boards?.items;
  if (!items || typeof items !== "object") {
    return null;
  }
  return items;
}

/** Boards the logged-in viewer can see, from Canny's `__data.boards.items`. */
export function readCannyBoards(
  target: Window & typeof globalThis,
): CannyBoard[] {
  const items = readBoardItems(target);
  if (!items) {
    return [];
  }
  const boards: CannyBoard[] = [];
  const seen = new Set<string>();
  for (const board of Object.values(items)) {
    const slug = typeof board?.urlName === "string" ? board.urlName.trim() : "";
    const name = typeof board?.name === "string" ? board.name.trim() : "";
    const id = typeof board?._id === "string" ? board._id.trim() : "";
    if (!slug || !name || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    boards.push({ slug, name, id });
  }
  return boards;
}

/**
 * Canny slugs that the public gateway does not index — private / restricted
 * boards this viewer can see.
 */
export function privateBoardSlugs(
  cannySlugs: Iterable<string>,
  gatewaySlugs: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of cannySlugs) {
    const slug = raw.trim();
    if (!slug || seen.has(slug) || gatewaySlugs.has(slug)) {
      continue;
    }
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export function csrfTokenFromViewer(
  target: Window & typeof globalThis,
): string {
  const viewer = (
    target as unknown as {
      __data?: {
        viewer?: Record<string, unknown> & { user?: Record<string, unknown> };
      };
    }
  ).__data?.viewer;
  if (!viewer || typeof viewer !== "object") {
    return "";
  }
  for (const key of ["csrfToken", "csrf_token", "csrf"] as const) {
    const value = viewer[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const nested = viewer.user;
  if (nested && typeof nested === "object") {
    for (const key of ["csrfToken", "csrf_token", "csrf"] as const) {
      const value = nested[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "";
}
