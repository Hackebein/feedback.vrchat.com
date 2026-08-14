export type VisiblePostAnchor = { id: string; top: number };

const POST_ITEM_SELECTOR = ".postListItem, .postListItemV2";
const MUTATION_TIMEOUT_MS = 400;

function urlNameFromItem(item: Element): string {
  if (item.closest("#vrcfb-roadmap")) {
    return "";
  }
  const link = item.querySelector("a[href*='/p/']");
  if (!(link instanceof HTMLAnchorElement)) {
    return "";
  }
  const href = link.getAttribute("href");
  if (!href) {
    return "";
  }
  const match = href.match(/\/p\/([^/?#]+)/);
  if (!match) {
    return "";
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function captureVisiblePost(
  target: Window & typeof globalThis,
): VisiblePostAnchor | null {
  const viewH = target.innerHeight;
  const items = Array.from(
    target.document.querySelectorAll(POST_ITEM_SELECTOR),
  );
  for (const el of items) {
    const id = urlNameFromItem(el);
    if (!id) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < viewH) {
      return { id, top: rect.top };
    }
  }
  return null;
}

export function restoreVisiblePost(
  target: Window & typeof globalThis,
  anchor: VisiblePostAnchor,
): void {
  const items = Array.from(
    target.document.querySelectorAll(POST_ITEM_SELECTOR),
  );
  for (const el of items) {
    if (urlNameFromItem(el) !== anchor.id) {
      continue;
    }
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) >= 1) {
      target.scrollBy(0, delta);
    }
    return;
  }
}

function postTop(
  target: Window & typeof globalThis,
  id: string,
): number | null {
  const items = Array.from(
    target.document.querySelectorAll(POST_ITEM_SELECTOR),
  );
  for (const el of items) {
    if (urlNameFromItem(el) === id) {
      return el.getBoundingClientRect().top;
    }
  }
  return null;
}

/**
 * Runs `update`, then restores the captured post’s viewport Y before paint
 * (MutationObserver microtask). Times out if the list never mutates.
 */
export async function withPreservedVisiblePost(
  target: Window & typeof globalThis,
  update: () => Promise<boolean>,
): Promise<boolean> {
  const anchor = captureVisiblePost(target);
  const ok = await update();
  if (!ok || !anchor) {
    return ok;
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      observer.disconnect();
      target.clearTimeout(timer);
      restoreVisiblePost(target, anchor);
      resolve();
    };
    const observer = new MutationObserver(() => {
      const top = postTop(target, anchor.id);
      if (top === null) {
        return;
      }
      if (Math.abs(top - anchor.top) >= 1) {
        finish();
      }
    });
    observer.observe(target.document.documentElement, {
      childList: true,
      subtree: true,
    });
    const timer = target.setTimeout(finish, MUTATION_TIMEOUT_MS);
  });
  return true;
}
