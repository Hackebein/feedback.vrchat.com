import { createCannyDropdown } from "./canny-dropdown";
import { currentSlug, isLocationCovered, onRouteChange } from "./coverage";

const STYLE_ID = "vrcfb-board-picker-style";
const PICKER_ID = "vrcfb-board-picker";
const TOGGLE_ID = "vrcfb-create-toggle";
const CREATE_FORM_SELECTOR = ".createPostFormV2";
const NATIVE_BOARD_LINK_SELECTOR = "ul.boardListContainer a";
const COLLAPSED_CLASS = "vrcfb-create-collapsed";

// Reuse Canny's `.createPostFormSection` / `.descriptionLabel` wrappers; the board
// picker uses the shared Canny-style searchable dropdown component.
const PICKER_CSS = `
html.${COLLAPSED_CLASS} .createPostFormV2 > *:not(#${TOGGLE_ID}) {
  display: none !important;
}
html:not(.${COLLAPSED_CLASS}) #${TOGGLE_ID} {
  display: none !important;
}
#${TOGGLE_ID} {
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: #2563eb;
  color: #fff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: center;
}
#${TOGGLE_ID}:hover {
  background: #1d4ed8;
}
#${TOGGLE_ID}:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
`;

type BoardOption = { slug: string; name: string };

/** Set before dropdown-driven router navigation; consumed by bridge preselect. */
let suppressBoardPreselect = false;

/** True once the user has opened the create form; preserved across dropdown board changes. */
let createFormExpanded = false;

/** Returns true once if the create-post dropdown just navigated boards. */
export function consumeBoardPreselectSuppression(): boolean {
  if (!suppressBoardPreselect) {
    return false;
  }
  suppressBoardPreselect = false;
  return true;
}

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
    suppressBoardPreselect = true;
    createFormExpanded = true;
    history.push(`/${slug}`);
  } else {
    console.warn("[vrcfb] router history not found; cannot switch board");
  }
}

function buildToggle(target: Window & typeof globalThis): HTMLButtonElement {
  const doc = target.document;
  const button = doc.createElement("button");
  button.id = TOGGLE_ID;
  button.type = "button";
  button.textContent = "Create post";
  button.addEventListener("click", () => {
    createFormExpanded = true;
    target.document.documentElement.classList.remove(COLLAPSED_CLASS);
  });
  return button;
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

  const current = currentSlug(target);
  const dropdown = createCannyDropdown({
    doc,
    options: options.map((option) => ({ value: option.slug, label: option.name })),
    value: current,
    placeholder: "Select board",
    searchable: true,
    onChange: (slug) => {
      if (slug && slug !== currentSlug(target)) {
        navigateToBoard(target, slug);
      }
    },
  });
  wrap.appendChild(dropdown.root);

  return wrap;
}

export function installCreateBoardSelect(target: Window & typeof globalThis): void {
  ensureStyles(target);

  const removeExisting = (): void => {
    target.document.getElementById(PICKER_ID)?.remove();
    target.document.getElementById(TOGGLE_ID)?.remove();
  };

  const mount = (): void => {
    const doc = target.document;
    if (!isLocationCovered(target)) {
      removeExisting();
      doc.documentElement.classList.remove(COLLAPSED_CLASS);
      createFormExpanded = false;
      return;
    }
    if (doc.getElementById(PICKER_ID) && doc.getElementById(TOGGLE_ID)) {
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
    if (!doc.getElementById(TOGGLE_ID)) {
      form.insertBefore(buildToggle(target), form.firstChild);
    }
    if (!doc.getElementById(PICKER_ID)) {
      const toggle = doc.getElementById(TOGGLE_ID);
      if (toggle?.nextSibling) {
        form.insertBefore(picker, toggle.nextSibling);
      } else {
        form.appendChild(picker);
      }
    }
    if (createFormExpanded) {
      doc.documentElement.classList.remove(COLLAPSED_CLASS);
    } else {
      doc.documentElement.classList.add(COLLAPSED_CLASS);
    }
  };

  // On a direct load / reload Canny server-renders the create form and then
  // React hydrates it (note the duplicated `createPostFormV2` class), which
  // clobbers any child we inject mid-hydration. Defer the first mount and the
  // observer until after `load` so we attach once hydration has settled. The
  // SPA navigation path already runs post-hydration, so it works immediately.
  const start = (): void => {
    mount();

    const observer = new MutationObserver(() => {
      const doc = target.document;
      if (!doc.getElementById(PICKER_ID) || !doc.getElementById(TOGGLE_ID)) {
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
