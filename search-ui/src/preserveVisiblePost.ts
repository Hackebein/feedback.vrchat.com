export type VisiblePostAnchor = { id: string; top: number };

function viewportHeight(doc: Document): number {
  return doc.defaultView?.innerHeight ?? 0;
}

function scrollContainer(el: Element): HTMLElement | null {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const overflow = parent.ownerDocument.defaultView?.getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll") return parent;
  }
  return null;
}

export function captureVisiblePost(
  doc: Document,
  selector: string,
  getId: (el: Element) => string,
): VisiblePostAnchor | null {
  const viewH = viewportHeight(doc);
  const items = Array.from(doc.querySelectorAll(selector));
  for (const el of items) {
    const id = getId(el);
    if (!id) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    const container = scrollContainer(el)?.getBoundingClientRect();
    const top = Math.max(0, container?.top ?? 0);
    const bottom = Math.min(viewH, container?.bottom ?? viewH);
    if (rect.bottom > top && rect.top < bottom) {
      return { id, top: rect.top };
    }
  }
  return null;
}

export function restoreVisiblePost(
  doc: Document,
  selector: string,
  getId: (el: Element) => string,
  anchor: VisiblePostAnchor,
): void {
  const win = doc.defaultView;
  if (!win) {
    return;
  }
  const items = Array.from(doc.querySelectorAll(selector));
  for (const el of items) {
    if (getId(el) !== anchor.id) {
      continue;
    }
    const delta = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) >= 1) {
      (scrollContainer(el) ?? win).scrollBy(0, delta);
    }
    return;
  }
}
