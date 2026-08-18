import { currentSlug, isLocationCovered, onRouteChange } from "./coverage";
import { buildPostMeta, postMetaFromHit } from "./list-augment";
import { getNativeFetch } from "./intercept";
import { postIdFromHit, submitCannyVote } from "./canny-vote";
import { fetchPresetPosts, type PresetQuery } from "./search-handler";
import {
  hitDisplayScore,
  hitVotedByViewer,
  viewerLoggedIn,
  viewerName,
} from "./viewer-votes";
import type { BridgeOptions } from "./types";

const STYLE_ID = "vrcfb-roadmap-style";
const ROADMAP_ID = "vrcfb-roadmap";
const HOME_CONTAINER_SELECTOR = ".subdomainHomeContents .topContainer";
const COLUMN_LIMIT = 10;

type Column = { title: string; color: string; preset: PresetQuery };

const COLUMNS: Column[] = [
  { title: "Most upvoted", color: "#8b5cf6", preset: { sort: "score_desc" } },
  {
    title: "Interested",
    color: "#1fa0ff",
    preset: { refinements: { status: ["interested"] }, sort: "statusChanged_desc" },
  },
  {
    title: "In Process",
    color: "#f59e0b",
    preset: { refinements: { status: ["in progress"] }, sort: "statusChanged_desc" },
  },
  {
    title: "Completed",
    color: "#16a34a",
    preset: { refinements: { status: ["complete"] }, sort: "statusChanged_desc" },
  },
  { title: "Recent activity", color: "#64748b", preset: { sort: "activity_desc" } },
  {
    title: "High engagement",
    color: "#ef4444",
    preset: { toggles: { vote_highEngagement: true } },
  },
];

const CHEVRON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-up chevron" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg>';

// The columns reuse Canny's own roadmap classes so they inherit native card
// styling; we only restore the side-by-side column layout (Canny's grid
// collapses to a single track inside our container) plus the loading hint.
const ROADMAP_CSS = `
#${ROADMAP_ID} { margin: 16px 0 24px; }
#${ROADMAP_ID} .roadmapColumns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
  overflow: visible;
}
#${ROADMAP_ID} .roadmapColumn {
  min-width: 0;
}
#${ROADMAP_ID} .vrcfb-roadmap-note {
  padding: 8px 4px;
  font-size: 13px;
  opacity: 0.6;
}
#${ROADMAP_ID} .postListItem {
  align-items: flex-start;
}
#${ROADMAP_ID} .postVotesV2 {
  flex: 0 0 auto;
  flex-shrink: 0;
  min-width: 36px;
}
#${ROADMAP_ID} .postLink {
  flex: 1 1 auto;
  min-width: 0;
}
#${ROADMAP_ID} .boardName {
  text-transform: none;
}
`;

/** The brand tint Canny applies to a voted vote button (border/background/chevron). */
function voteTint(target: Window & typeof globalThis): string {
  const tint = (target as unknown as {
    __data?: { company?: { tintColor?: unknown } };
  }).__data?.company?.tintColor;
  return typeof tint === "string" ? tint : "";
}

/**
 * Reproduces Canny's voted vote-button styling on our hand-built button: the
 * `highlight` class (its CSS fades the `.background` opacity) plus the company
 * tint inlined on the border, `.background` fill, and chevron — exactly as
 * Canny's component does, leaving the score at its default colour.
 */
function applyVotedTint(
  target: Window & typeof globalThis,
  button: HTMLElement,
): void {
  const tint = voteTint(target);
  if (!tint) {
    return;
  }
  button.classList.add("highlight");
  button.style.borderColor = tint;
  const background = button.querySelector<HTMLElement>(".background");
  if (background) {
    background.style.backgroundColor = tint;
  }
  const chevron = button.querySelector<HTMLElement>(".chevron");
  if (chevron) {
    chevron.style.color = tint;
  }
}

function clearVotedTint(button: HTMLElement): void {
  button.classList.remove("highlight");
  button.style.borderColor = "";
  const background = button.querySelector<HTMLElement>(".background");
  if (background) {
    background.style.backgroundColor = "";
  }
  const chevron = button.querySelector<HTMLElement>(".chevron");
  if (chevron) {
    chevron.style.color = "";
  }
}

function setVoteAppearance(
  target: Window & typeof globalThis,
  button: HTMLElement,
  voted: boolean,
  score: number,
): void {
  const scoreEl = button.querySelector(".score");
  if (scoreEl) {
    scoreEl.textContent = String(score);
  }
  button.setAttribute("aria-pressed", voted ? "true" : "false");
  if (voted) {
    applyVotedTint(target, button);
  } else {
    clearVotedTint(button);
  }
}

function ensureStyles(target: Window & typeof globalThis): void {
  const doc = target.document;
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = ROADMAP_CSS;
  doc.documentElement.appendChild(style);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function postUrl(hit: Record<string, unknown>): string | null {
  const board = hit.board as { urlName?: string } | undefined;
  const boardSlug = readString(board?.urlName);
  const postSlug = readString(hit.urlName);
  if (!boardSlug || !postSlug) {
    return null;
  }
  return `/${boardSlug}/p/${postSlug}`;
}

function columnsFor(target: Window & typeof globalThis): Column[] {
  const columns = [...COLUMNS];
  if (viewerLoggedIn(target)) {
    const name = viewerName(target);
    if (name) {
      columns.push({
        title: "Your votes",
        color: "#0ea5e9",
        preset: {
          refinements: { voter_name: [name] },
          sort: "activity_desc",
        },
      });
    }
  }
  return columns;
}

function note(doc: Document, text: string): HTMLElement {
  const div = doc.createElement("div");
  div.className = "vrcfb-roadmap-note";
  div.textContent = text;
  return div;
}

function bindRoadmapVote(
  target: Window & typeof globalThis,
  button: HTMLButtonElement,
  hit: Record<string, unknown>,
): void {
  const postId = postIdFromHit(hit);
  const url = postUrl(hit);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!postId) {
      return;
    }
    if (!viewerLoggedIn(target)) {
      if (url) {
        target.location.assign(url);
      }
      return;
    }
    if (button.disabled) {
      return;
    }
    const voted = hitVotedByViewer(target, hit);
    const next: 0 | 1 = voted ? 0 : 1;
    const previousScore = hitDisplayScore(hit);
    setVoteAppearance(target, button, next === 1, previousScore + (next === 1 ? 1 : -1));
    button.disabled = true;
    void submitCannyVote(target, postId, next, getNativeFetch(target))
      .then((ok) => {
        if (!ok) {
          setVoteAppearance(target, button, voted, previousScore);
        }
      })
      .catch((error) => {
        console.warn("[vrcfb] roadmap vote failed", error);
        setVoteAppearance(target, button, voted, previousScore);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

function renderItems(
  target: Window & typeof globalThis,
  posts: HTMLElement,
  hits: Record<string, unknown>[],
): void {
  const doc = target.document;
  posts.replaceChildren();
  if (hits.length === 0) {
    posts.appendChild(note(doc, "No posts."));
    return;
  }
  for (const hit of hits) {
    const title = readString(hit.title);
    if (!title) {
      continue;
    }
    const item = doc.createElement("div");
    item.className = "postListItem";

    const votes = doc.createElement("button");
    votes.type = "button";
    votes.className = "postVotesV2";
    const voted = hitVotedByViewer(target, hit);
    votes.setAttribute("aria-pressed", voted ? "true" : "false");
    const score = hitDisplayScore(hit);
    votes.innerHTML = `<div class="background"></div>${CHEVRON_SVG}<span class="score">${score}</span>`;
    item.appendChild(votes);
    bindRoadmapVote(target, votes, hit);

    const board = hit.board as { _id?: string; name?: string } | undefined;

    // Reflect the viewer's existing upvote. Canny renders these buttons itself
    // for real posts; we replicate exactly what its component does for the voted
    // state: add `highlight` (its CSS fades the .background) and inline the
    // company tint on the border, background, and chevron — leaving the score at
    // its default colour.
    if (voted) {
      applyVotedTint(target, votes);
    }

    const link = doc.createElement("a");
    link.className = "postLink";
    link.target = "_blank";
    link.rel = "noreferrer";
    const url = postUrl(hit);
    if (url) {
      link.href = url;
    }

    const body = doc.createElement("div");
    body.className = "body";
    const titleEl = doc.createElement("div");
    titleEl.className = "postTitle";
    const titleSpan = doc.createElement("span");
    titleSpan.textContent = title;
    titleEl.appendChild(titleSpan);
    body.appendChild(titleEl);

    const boardName = readString(board?.name);
    if (boardName) {
      const boardEl = doc.createElement("div");
      boardEl.className = "boardName text-secondary-foreground text-sm";
      boardEl.textContent = boardName;
      body.appendChild(boardEl);
    }

    const meta = postMetaFromHit(hit);
    if (meta.authorName || meta.createdLabel) {
      body.appendChild(buildPostMeta(doc, meta));
    }

    link.appendChild(body);
    item.appendChild(link);
    posts.appendChild(item);
  }
}

function buildRoadmap(
  options: BridgeOptions,
  target: Window & typeof globalThis,
): HTMLElement {
  const doc = target.document;
  const root = doc.createElement("section");
  root.id = ROADMAP_ID;
  // Reuse Canny's roadmap class so the native column borders, header bars, and
  // title styling apply; the hide rule excludes our id.
  root.className = "roadmapView";

  const header = doc.createElement("header");
  header.className = "header";
  const heading = doc.createElement("h2");
  heading.className = "textV2 headingMd";
  heading.textContent = "Roadmap";
  header.appendChild(heading);
  root.appendChild(header);

  const columns = doc.createElement("div");
  columns.className = "roadmapColumns";
  root.appendChild(columns);

  for (const column of columnsFor(target)) {
    const col = doc.createElement("div");
    col.className = "roadmapColumn";

    const columnHeader = doc.createElement("div");
    columnHeader.className = "columnHeader";
    const dot = doc.createElement("div");
    dot.className = "dot";
    dot.style.background = column.color;
    const title = doc.createElement("h3");
    title.className = "textV2 statusName headingSm";
    title.textContent = column.title;
    columnHeader.append(dot, title);
    col.appendChild(columnHeader);

    const scroll = doc.createElement("div");
    scroll.className = "scrollContainer scrollable";
    const postList = doc.createElement("div");
    postList.className = "postList";
    postList.appendChild(
      Object.assign(doc.createElement("div"), { className: "topContainer" }),
    );
    const posts = doc.createElement("div");
    posts.className = "posts";
    posts.appendChild(note(doc, "Loading\u2026"));
    postList.appendChild(posts);
    scroll.appendChild(postList);
    col.appendChild(scroll);
    columns.appendChild(col);

    void fetchPresetPosts(options, column.preset, COLUMN_LIMIT)
      .then((hits) => {
        renderItems(target, posts, hits);
      })
      .catch(() => {
        posts.replaceChildren(note(doc, "Failed to load."));
      });
  }

  return root;
}

export function installRoadmap(
  options: BridgeOptions,
  target: Window & typeof globalThis,
): void {
  ensureStyles(target);

  const mount = (): void => {
    const doc = target.document;
    // The roadmap replaces the native one only on the covered home page.
    if (currentSlug(target) !== "" || !isLocationCovered(target)) {
      doc.getElementById(ROADMAP_ID)?.remove();
      return;
    }
    if (doc.getElementById(ROADMAP_ID)) {
      return;
    }
    const container = doc.querySelector<HTMLElement>(HOME_CONTAINER_SELECTOR);
    if (!container) {
      return;
    }
    container.appendChild(buildRoadmap(options, target));
  };

  mount();

  const observer = new MutationObserver(() => {
    const present = !!target.document.getElementById(ROADMAP_ID);
    const onHome = currentSlug(target) === "";
    if ((onHome && !present) || (!onHome && present)) {
      mount();
    }
  });
  observer.observe(target.document.documentElement, {
    childList: true,
    subtree: true,
  });

  onRouteChange(target, mount);
}
