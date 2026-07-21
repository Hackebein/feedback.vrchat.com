import { onSearchContext } from "./search-handler";
import { isLocationCovered } from "./coverage";
import type { SearchContext } from "./types";

const STYLE_ID = "vrcfb-augment-style";
const META_CLASS = "vrcfb-post-meta";
const HIGHLIGHT_NAME = "vrcfb-search";
const POST_ITEM_SELECTOR = ".postListItem, .postListItemV2";

const AUGMENT_CSS = `
.${META_CLASS} {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: inherit;
  white-space: nowrap;
}
.${META_CLASS} .vrcfb-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.${META_CLASS} .vrcfb-sep {
  opacity: 0.55;
}
.${META_CLASS} .vrcfb-avatar {
  width: 14px;
  height: 14px;
  border-radius: 999px;
  object-fit: cover;
  flex-shrink: 0;
}
.${META_CLASS} .vrcfb-avatar-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.28);
  color: currentColor;
  font-size: 8px;
  font-weight: 650;
  text-transform: uppercase;
}
.${META_CLASS} .vrcfb-author {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(250, 204, 21, 0.45);
  color: inherit;
  border-radius: 2px;
}
`;

type PostMeta = {
  authorName: string;
  avatarURL: string;
  createdLabel: string;
  createdISO: string;
};

export type { PostMeta };

let metaByUrlName = new Map<string, PostMeta>();
let activeTerms: string[] = [];

function readString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

function formatCreatedAt(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    return "";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function extractTerms(query: string): string[] {
  if (!query) {
    return [];
  }

  const terms: string[] = [];
  let rest = query;

  rest = rest.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const trimmed = phrase.trim();
    if (trimmed) {
      terms.push(trimmed);
    }
    return " ";
  });

  rest = rest
    .replace(/[A-Za-z_][\w.]*\s*:/g, " ")
    .replace(/\b(?:AND|OR|NOT|TO)\b/g, " ")
    .replace(/[()[\]{}^~]/g, " ");

  for (const rawToken of rest.split(/\s+/)) {
    const trimmed = rawToken
      .replace(/^[+\-*?]+|[+\-*?]+$/g, "")
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (trimmed.length >= 2) {
      terms.push(trimmed);
    }
  }

  return [...new Set(terms.filter((term) => term.length > 0))];
}

function ensureStyles(target: Window & typeof globalThis): void {
  if (target.document.getElementById(STYLE_ID)) {
    return;
  }
  const style = target.document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = AUGMENT_CSS;
  target.document.documentElement.appendChild(style);
}

function urlNameFromLink(link: HTMLAnchorElement): string | null {
  const href = link.getAttribute("href");
  if (!href) {
    return null;
  }
  const match = href.match(/\/p\/([^/?#]+)/);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function appendSeparator(doc: Document, parent: HTMLElement): void {
  const sep = doc.createElement("span");
  sep.className = "vrcfb-sep";
  sep.setAttribute("aria-hidden", "true");
  sep.textContent = "·";
  parent.appendChild(sep);
}

export function postMetaFromHit(hit: Record<string, unknown>): PostMeta {
  const author = hit.author;
  return {
    authorName: readString(author, "name"),
    avatarURL: readString(author, "avatarURL"),
    createdLabel: formatCreatedAt(hit.created),
    createdISO: typeof hit.created === "string" ? hit.created : "",
  };
}

export function buildPostMeta(doc: Document, meta: PostMeta): HTMLElement {
  const group = doc.createElement("span");
  group.className = `${META_CLASS} text-secondary-foreground text-sm`;

  if (meta.authorName) {
    appendSeparator(doc, group);

    const chip = doc.createElement("span");
    chip.className = "vrcfb-chip";

    if (meta.avatarURL) {
      const avatar = doc.createElement("img");
      avatar.className = "vrcfb-avatar";
      avatar.src = meta.avatarURL;
      avatar.alt = "";
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      chip.appendChild(avatar);
    } else {
      const placeholder = doc.createElement("span");
      placeholder.className = "vrcfb-avatar vrcfb-avatar-placeholder";
      placeholder.setAttribute("aria-hidden", "true");
      placeholder.textContent = meta.authorName.slice(0, 1);
      chip.appendChild(placeholder);
    }

    const author = doc.createElement("span");
    author.className = "vrcfb-author";
    author.textContent = meta.authorName;
    chip.appendChild(author);

    group.appendChild(chip);
  }

  if (meta.createdLabel) {
    appendSeparator(doc, group);

    const chip = doc.createElement("span");
    chip.className = "vrcfb-chip";
    const created = doc.createElement("time");
    created.textContent = meta.createdLabel;
    if (meta.createdISO) {
      created.dateTime = meta.createdISO;
    }
    chip.appendChild(created);
    group.appendChild(chip);
  }

  return group;
}

function buildMetaGroup(
  target: Window & typeof globalThis,
  meta: PostMeta,
): HTMLElement {
  return buildPostMeta(target.document, meta);
}

function findMetaTarget(item: HTMLElement): HTMLElement | null {
  const body = item.querySelector<HTMLElement>(".postListItemBody");
  if (body) {
    const row = body.lastElementChild;
    return row instanceof HTMLElement ? row : body;
  }
  return item.querySelector<HTMLElement>(".body");
}

function augmentAll(target: Window & typeof globalThis): void {
  const items = Array.from(
    target.document.querySelectorAll<HTMLElement>(POST_ITEM_SELECTOR),
  );
  for (const item of items) {
    if (item.closest("#vrcfb-roadmap")) {
      continue;
    }
    const link = item.querySelector<HTMLAnchorElement>("a.postLink");
    const metaTarget = findMetaTarget(item);
    if (!link || !metaTarget) {
      continue;
    }

    const urlName = urlNameFromLink(link);
    const meta = urlName ? metaByUrlName.get(urlName) : undefined;

    const existing = item.querySelector(`.${META_CLASS}`);
    if (!meta) {
      existing?.remove();
      continue;
    }
    if (existing) {
      continue;
    }

    metaTarget.appendChild(buildMetaGroup(target, meta));
  }
}

type HighlightCtor = new (...ranges: Range[]) => unknown;

function applyHighlights(target: Window & typeof globalThis): void {
  const cssApi = (target as unknown as { CSS?: { highlights?: Map<string, unknown> } })
    .CSS;
  const HighlightClass = (target as unknown as { Highlight?: HighlightCtor })
    .Highlight;
  if (!cssApi?.highlights || typeof HighlightClass !== "function") {
    return;
  }

  cssApi.highlights.delete(HIGHLIGHT_NAME);
  if (activeTerms.length === 0) {
    return;
  }

  const lowerTerms = activeTerms.map((term) => term.toLowerCase());
  const ranges: Range[] = [];
  const items = Array.from(
    target.document.querySelectorAll<HTMLElement>(POST_ITEM_SELECTOR),
  );

  for (const item of items) {
    if (item.closest("#vrcfb-roadmap")) {
      continue;
    }
    const walker = target.document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (!node.parentElement?.closest(`.${META_CLASS}`)) {
        const text = node.nodeValue ?? "";
        const lower = text.toLowerCase();
        for (const term of lowerTerms) {
          let index = lower.indexOf(term);
          while (index !== -1) {
            const range = target.document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + term.length);
            ranges.push(range);
            index = lower.indexOf(term, index + term.length);
          }
        }
      }
      node = walker.nextNode();
    }
  }

  if (ranges.length > 0) {
    cssApi.highlights.set(HIGHLIGHT_NAME, new HighlightClass(...ranges));
  }
}

export function installListAugment(
  target: Window & typeof globalThis = window,
): void {
  ensureStyles(target);

  let scheduled = false;
  const refresh = (): void => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    target.requestAnimationFrame(() => {
      scheduled = false;
      if (!isLocationCovered(target)) {
        return;
      }
      augmentAll(target);
      applyHighlights(target);
    });
  };

  onSearchContext((context: SearchContext) => {
    const posts = context.cannyResponse.result?.posts ?? [];
    const next = new Map<string, PostMeta>();
    for (const post of posts) {
      const urlName = readString(post, "urlName");
      if (!urlName) {
        continue;
      }
      next.set(urlName, {
        authorName: readString(post.author, "name"),
        avatarURL: readString(post.author, "avatarURL"),
        createdLabel: formatCreatedAt(post.created),
        createdISO: typeof post.created === "string" ? post.created : "",
      });
    }
    metaByUrlName = next;
    activeTerms = extractTerms(readString(context.cannyBody, "textSearch"));
    refresh();
  });

  const observer = new MutationObserver(refresh);
  observer.observe(target.document.documentElement, {
    childList: true,
    subtree: true,
  });
}
