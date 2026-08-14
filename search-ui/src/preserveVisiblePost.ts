export type VisiblePostAnchor = { id: string; top: number };

function viewportHeight(doc: Document): number {
  return doc.defaultView?.innerHeight ?? 0;
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
    if (rect.bottom > 0 && rect.top < viewH) {
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
      win.scrollBy(0, delta);
    }
    return;
  }
}
