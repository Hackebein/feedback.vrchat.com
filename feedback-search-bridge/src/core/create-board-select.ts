import { currentSlug, isLocationCovered, onRouteChange } from "./coverage";

const STYLE_ID = "vrcfb-board-picker-style";
const PICKER_ID = "vrcfb-board-picker";
const CREATE_FORM_SELECTOR = ".createPostFormV2";
const NATIVE_BOARD_LINK_SELECTOR = "ul.boardListContainer a";

// Reuse Canny's `.createPostFormSection` / `.descriptionLabel` wrappers and its
// `.input-border` utility on the <select>; the rest mimics Canny's dropdowns
// (bordered, rounded, chevron affordance) via an appearance reset.
const PICKER_CSS = `
#${PICKER_ID} select {
  width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 30px 0 12px;
  border-radius: 6px;
  color: inherit;
  font: inherit;
  background-color: transparent;
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  background-size: 16px;
  cursor: pointer;
}
`;

type BoardOption = { slug: string; name: string };

function ensureStyles(target: Window & typeof globalThis): void {
  const doc = target.document;
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = PICKER_CSS;
  doc.documentElement.appendChild(style);
}

function slugFromHref(href: string | null): string {
  if (!href) {
    return "";
  }
  const match = /^\/([^/?#]+)$/.exec(href.trim());
  return match ? match[1] : "";
}

function readBoardOptions(target: Window & typeof globalThis): BoardOption[] {
  const seen = new Set<string>();
  const options: BoardOption[] = [];

  // Canny's Redux-hydrated store is available earlier than the (hidden) board
  // list anchors, so prefer it for a reliable list on direct page loads.
  const store = (target as unknown as {
    __data?: { boards?: { items?: Record<string, { urlName?: string; name?: string }> } };
  }).__data;
  const items = store?.boards?.items;
  if (items && typeof items === "object") {
    for (const board of Object.values(items)) {
      const slug = typeof board?.urlName === "string" ? board.urlName.trim() : "";
      const name = typeof board?.name === "string" ? board.name.trim() : "";
      if (slug && name && !seen.has(slug)) {
        seen.add(slug);
        options.push({ slug, name });
      }
    }
  }

  if (options.length === 0) {
    const anchors = Array.from(
      target.document.querySelectorAll<HTMLAnchorElement>(NATIVE_BOARD_LINK_SELECTOR),
    );
    for (const anchor of anchors) {
      const slug = slugFromHref(anchor.getAttribute("href"));
      const name = (anchor.textContent ?? "").trim();
      if (slug && name && !seen.has(slug)) {
        seen.add(slug);
        options.push({ slug, name });
      }
    }
  }

  return options;
}

type RouterHistory = { push: (path: string) => void; location?: unknown };

let cachedHistory: RouterHistory | null = null;

/** The React fiber attached to a DOM node (React 16 legacy or 17+ keys). */
function fiberOf(el: Element | null): { memoizedProps?: Record<string, unknown>; return?: unknown } | null {
  if (!el) {
    return null;
  }
  const key = Object.keys(el).find(
    (k) => k.startsWith("__reactInternalInstance$") || k.startsWith("__reactFiber$"),
  );
  return key ? ((el as unknown as Record<string, unknown>)[key] as never) : null;
}

function isHistory(value: unknown): value is RouterHistory {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as RouterHistory).push === "function" &&
    "location" in (value as Record<string, unknown>)
  );
}

/**
 * Canny's board links navigate via react-router, which only responds to trusted
 * clicks — synthetic events don't switch boards (so the create form never
 * re-renders its board-specific fields). Instead we pull the router `history`
 * out of the fiber tree and push directly, which is what a real click does.
 */
function getRouterHistory(target: Window & typeof globalThis): RouterHistory | null {
  if (cachedHistory) {
    return cachedHistory;
  }
  const doc = target.document;
  const start =
    doc.querySelector(".createPostFormV2") ??
    doc.querySelector('a[href^="/"]') ??
    doc.body;
  let fiber = fiberOf(start);
  let depth = 0;
  while (fiber && depth < 400) {
    const props = fiber.memoizedProps;
    if (props) {
      for (const key of ["value", "history", "context"] as const) {
        const value = props[key];
        if (isHistory(value)) {
          cachedHistory = value;
          return value;
        }
        const nested = (value as { history?: unknown } | undefined)?.history;
        if (isHistory(nested)) {
          cachedHistory = nested;
          return nested;
        }
      }
    }
    fiber = fiber.return as typeof fiber;
    depth += 1;
  }
  return null;
}

function navigateToBoard(target: Window & typeof globalThis, slug: string): void {
  // Drive react-router directly so the create form re-renders with that board's
  // fields and the URL updates without a full reload (preserving filter state).
  const history = getRouterHistory(target);
  if (history) {
    history.push(`/${slug}`);
  } else {
    console.warn("[vrcfb] router history not found; cannot switch board");
  }
}

function buildPicker(target: Window & typeof globalThis): HTMLElement | null {
  const options = readBoardOptions(target);
  if (options.length === 0) {
    return null;
  }
  const doc = target.document;

  const wrap = doc.createElement("div");
  wrap.id = PICKER_ID;
  wrap.className = "createPostFormSection";

  const label = doc.createElement("label");
  label.className = "descriptionLabel";
  const labelText = doc.createElement("p");
  labelText.className = "textV2 bodyMd medium-weight";
  labelText.textContent = "Post to board";
  label.appendChild(labelText);
  wrap.appendChild(label);

  const select = doc.createElement("select");
  select.className = "input-border";
  const current = currentSlug(target);
  for (const option of options) {
    const node = doc.createElement("option");
    node.value = option.slug;
    node.textContent = option.name;
    if (option.slug === current) {
      node.selected = true;
    }
    select.appendChild(node);
  }
  select.addEventListener("change", () => {
    const slug = select.value;
    if (slug && slug !== currentSlug(target)) {
      navigateToBoard(target, slug);
    }
  });
  wrap.appendChild(select);

  return wrap;
}

export function installCreateBoardSelect(target: Window & typeof globalThis): void {
  ensureStyles(target);

  const removeExisting = (): void => {
    target.document.getElementById(PICKER_ID)?.remove();
  };

  const mount = (): void => {
    const doc = target.document;
    if (!isLocationCovered(target)) {
      removeExisting();
      return;
    }
    if (doc.getElementById(PICKER_ID)) {
      return;
    }
    const form = doc.querySelector<HTMLElement>(CREATE_FORM_SELECTOR);
    if (!form) {
      return;
    }
    const picker = buildPicker(target);
    if (!picker) {
      return;
    }
    form.insertBefore(picker, form.firstChild);
  };

  // On a direct load / reload Canny server-renders the create form and then
  // React hydrates it (note the duplicated `createPostFormV2` class), which
  // clobbers any child we inject mid-hydration. Defer the first mount and the
  // observer until after `load` so we attach once hydration has settled. The
  // SPA navigation path already runs post-hydration, so it works immediately.
  const start = (): void => {
    mount();

    const observer = new MutationObserver(() => {
      if (!target.document.getElementById(PICKER_ID)) {
        mount();
      }
    });
    observer.observe(target.document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Rebuild on SPA navigation so the selected board reflects the new URL.
    onRouteChange(target, () => {
      removeExisting();
      mount();
    });
  };

  if (target.document.readyState === "complete") {
    start();
  } else {
    target.addEventListener("load", start, { once: true });
  }
}
