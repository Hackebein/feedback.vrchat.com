import { GATEWAY_ORIGIN, INDEX_NAME, SEARCH_API_PATH } from "./config";
import type { BridgeOptions } from "./types";

export const ACTIVE_CLASS = "vrcfb-active";

let gatewaySlugs: Set<string> | null = null;
let privateSlugs = new Set<string>();
let coveredSlugs: Set<string> | null = null;

export function unionCoveredSlugs(
  gateway: Iterable<string>,
  extra: Iterable<string>,
): Set<string> {
  return new Set([...gateway, ...extra]);
}

function rebuildCoveredSlugs(): void {
  if (!gatewaySlugs) {
    coveredSlugs = null;
    return;
  }
  coveredSlugs = unionCoveredSlugs(gatewaySlugs, privateSlugs);
}

/** Board slugs the public gateway indexes. Null until coverage has loaded. */
export function getGatewayCoveredSlugs(): ReadonlySet<string> | null {
  return gatewaySlugs;
}

/**
 * Extra slugs (private boards) the local index will serve. Unioned into
 * coverage so those board pages activate the bridge.
 */
export function setPrivateCoveredSlugs(slugs: Iterable<string>): void {
  const next = new Set<string>();
  for (const slug of slugs) {
    const trimmed = slug.trim();
    if (trimmed) {
      next.add(trimmed);
    }
  }
  privateSlugs = next;
  const hadGateway = gatewaySlugs !== null;
  rebuildCoveredSlugs();
  if (hadGateway) {
    notifyCoverage();
  }
}

const coverageListeners = new Set<() => void>();
const routeListeners = new Set<() => void>();
let routeHooked = false;

export function onCoverageChange(listener: () => void): () => void {
  coverageListeners.add(listener);
  return () => {
    coverageListeners.delete(listener);
  };
}

function notifyCoverage(): void {
  for (const listener of coverageListeners) {
    try {
      listener();
    } catch (error) {
      console.warn("[vrcfb] coverage listener failed", error);
    }
  }
}

/**
 * Fetches the set of board slugs the gateway actually indexes (the `board_slug`
 * facet). Boards present in Canny but absent here are "not covered" and the
 * bridge stays out of their way.
 */
export async function loadCoverage(options: BridgeOptions): Promise<void> {
  try {
    const response = await options.transport({
      url: `${GATEWAY_ORIGIN}${SEARCH_API_PATH}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify([
        {
          indexName: INDEX_NAME,
          params: {
            query: "",
            hitsPerPage: 0,
            page: 0,
            facets: ["board_slug"],
            maxValuesPerFacet: 500,
          },
        },
      ]),
    });
    if (response.status < 200 || response.status >= 300) {
      return;
    }
    const data = JSON.parse(response.responseText) as {
      results?: { facets?: Record<string, Record<string, number>> }[];
    };
    const facet = data.results?.[0]?.facets?.board_slug;
    if (facet && typeof facet === "object") {
      gatewaySlugs = new Set(Object.keys(facet));
      rebuildCoveredSlugs();
      notifyCoverage();
    }
  } catch (error) {
    console.warn("[vrcfb] coverage load failed", error);
  }
}

export function pathnameSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function currentSlug(target: Window & typeof globalThis): string {
  return pathnameSegments(target.location.pathname)[0] ?? "";
}

/** Post detail pages look like `/{board}/p/{postSlug}`. */
export function isPostDetailPath(pathname: string): boolean {
  return pathnameSegments(pathname)[1] === "p";
}

/**
 * Post detail pages look like `/{board}/p/{postSlug}`. The bridge (filters,
 * intercept, etc.) should stay off these so Canny renders the post normally.
 */
export function isPostDetail(target: Window & typeof globalThis): boolean {
  return isPostDetailPath(target.location.pathname);
}

/** Dedicated create pages look like `/{board}/create`. */
export function isCreatePagePath(pathname: string): boolean {
  return pathnameSegments(pathname)[1] === "create";
}

export function isCreatePage(target: Window & typeof globalThis): boolean {
  return isCreatePagePath(target.location.pathname);
}

/**
 * Home and indexed board list pages. Post detail and create pages are never
 * covered — Canny must render those itself. Until coverage has loaded we
 * optimistically treat remaining routes as covered so indexed boards never
 * flash the plain Canny UI; once loaded, genuinely unknown slugs are excluded.
 */
export function isLocationCoveredPath(
  pathname: string,
  slugs: ReadonlySet<string> | null = null,
): boolean {
  if (isPostDetailPath(pathname) || isCreatePagePath(pathname)) {
    return false;
  }
  const slug = pathnameSegments(pathname)[0] ?? "";
  if (slug === "") {
    return true;
  }
  if (!slugs) {
    return true;
  }
  return slugs.has(slug);
}

export function isLocationCovered(target: Window & typeof globalThis): boolean {
  return isLocationCoveredPath(target.location.pathname, coveredSlugs);
}

/**
 * Home, indexed board lists, and `/{board}/create`. The create-post picker
 * must stay available on create pages after the search bridge has turned off.
 */
export function isCreatePickerLocation(
  target: Window & typeof globalThis,
): boolean {
  if (isPostDetail(target)) {
    return false;
  }
  const slug = currentSlug(target);
  if (slug === "") {
    return true;
  }
  if (!coveredSlugs) {
    return true;
  }
  return coveredSlugs.has(slug);
}

export function applyActiveClass(target: Window & typeof globalThis): void {
  target.document.documentElement.classList.toggle(
    ACTIVE_CLASS,
    isLocationCovered(target),
  );
}

function ensureRouteHook(target: Window & typeof globalThis): void {
  if (routeHooked) {
    return;
  }
  routeHooked = true;
  const fire = (): void => {
    for (const listener of routeListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("[vrcfb] route listener failed", error);
      }
    }
  };
  const history = target.history;
  const wrap = <T extends (...args: never[]) => unknown>(original: T): T =>
    function wrapped(this: History, ...args: Parameters<T>) {
      const result = original.apply(this, args);
      fire();
      return result;
    } as unknown as T;
  history.pushState = wrap(history.pushState.bind(history));
  history.replaceState = wrap(history.replaceState.bind(history));
  target.addEventListener("popstate", fire);
}

export function onRouteChange(
  target: Window & typeof globalThis,
  listener: () => void,
): () => void {
  ensureRouteHook(target);
  routeListeners.add(listener);
  return () => {
    routeListeners.delete(listener);
  };
}
