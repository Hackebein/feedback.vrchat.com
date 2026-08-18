import { extractPostFromData, parseCannyData } from "./canny-html";
import {
  getGatewayCoveredSlugs,
  setPrivateCoveredSlugs,
} from "./coverage";
import { getNativeFetch } from "./intercept";
import {
  csrfTokenFromViewer,
  privateBoardSlugs,
  readCannyBoards,
} from "./private-boards";
import { toStoredPost } from "./private-search";
import {
  countPrivatePosts,
  deletePrivatePosts,
  ensurePrivateStore,
  getAllPrivatePosts,
  getCommentQueue,
  getPrivatePost,
  getPrivatePostsByBoard,
  markBoardListSync,
  putPrivatePosts,
  setCommentQueue,
  type StoredPrivatePost,
} from "./private-store";
import { viewerId, viewerLoggedIn } from "./viewer-votes";

const LIST_PAGES = 50;
const COMMENT_GAP_MS = 1500;
const LIST_GAP_MS = 250;
const LIST_RESYNC_MS = 5 * 60 * 1000;
const DATA_WAIT_MS = 15000;

export type PrivateIndexStatus = {
  phase: "idle" | "listing" | "comments";
  postCount: number;
  commentDone: number;
  commentTotal: number;
  boardCount: number;
};

type IndexListener = (status: PrivateIndexStatus) => void;

const listeners = new Set<IndexListener>();

let status: PrivateIndexStatus = {
  phase: "idle",
  postCount: 0,
  commentDone: 0,
  commentTotal: 0,
  boardCount: 0,
};

let started = false;
let resyncTimer: number | null = null;
let commentAbort = false;

export function getPrivateIndexStatus(): PrivateIndexStatus {
  return { ...status };
}

export function onPrivateIndexStatus(listener: IndexListener): () => void {
  listeners.add(listener);
  listener(getPrivateIndexStatus());
  return () => {
    listeners.delete(listener);
  };
}

function emitStatus(): void {
  const snapshot = getPrivateIndexStatus();
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn("[vrcfb] private index status listener failed", error);
    }
  }
}

function setStatus(patch: Partial<PrivateIndexStatus>): void {
  status = { ...status, ...patch };
  emitStatus();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitVisible(target: Window & typeof globalThis): Promise<void> {
  if (!target.document.hidden) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (!target.document.hidden) {
        target.document.removeEventListener("visibilitychange", onChange);
        resolve();
      }
    };
    target.document.addEventListener("visibilitychange", onChange);
  });
}

async function waitForViewer(
  target: Window & typeof globalThis,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (viewerLoggedIn(target) && readCannyBoards(target).length > 0) {
      return true;
    }
    await delay(150);
  }
  return viewerLoggedIn(target);
}

function postIdOf(payload: Record<string, unknown>): string {
  return typeof payload._id === "string" ? payload._id.trim() : "";
}

function mergeListed(
  prev: StoredPrivatePost | undefined,
  listed: Record<string, unknown>,
  boardSlug: string,
): StoredPrivatePost {
  const nextPayload = { ...listed };
  const listedCount =
    typeof listed.commentCount === "number" && Number.isFinite(listed.commentCount)
      ? listed.commentCount
      : 0;
  if (
    prev?.payload.comments &&
    Array.isArray(prev.payload.comments) &&
    listedCount === prev.listedCommentCount
  ) {
    nextPayload.comments = prev.payload.comments;
  }
  const stored = toStoredPost(nextPayload, boardSlug, prev);
  if (prev?.detailedAt && listedCount === prev.listedCommentCount) {
    stored.detailedAt = prev.detailedAt;
    stored.combinedText = prev.combinedText;
    stored.lastActivityAt = Math.max(stored.lastActivityAt, prev.lastActivityAt);
  }
  return stored;
}

function needsCommentFetch(post: StoredPrivatePost): boolean {
  if (!post.detailedAt) {
    return true;
  }
  const payloadCount =
    typeof post.payload.commentCount === "number" ? post.payload.commentCount : 0;
  const storedComments = Array.isArray(post.payload.comments)
    ? post.payload.comments.length
    : 0;
  return payloadCount !== storedComments;
}

async function cannyPostJson(
  target: Window & typeof globalThis,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const nativeFetch = getNativeFetch(target);
  const csrf = csrfTokenFromViewer(target);
  const payload = csrf ? { ...body, csrfToken: csrf } : body;
  const response = await nativeFetch(`${target.location.origin}/api/posts/get`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

async function fetchBoardListPage(
  target: Window & typeof globalThis,
  slug: string,
  sort: string,
  skip?: number,
): Promise<{ posts: Record<string, unknown>[]; hasNextPage: boolean; ok: boolean }> {
  const body: Record<string, unknown> = {
    __canny_requestID: `vrcfb-index-${slug}-${sort}-${skip ?? 0}`,
    __host: target.location.host,
    boardURLNames: [slug],
    currentBoard: slug,
    pages: LIST_PAGES,
    sort,
    status: "",
  };
  if (typeof skip === "number" && skip > 0) {
    body.skip = skip;
  }
  const { status: httpStatus, json } = await cannyPostJson(target, body);
  if (httpStatus === 401 || httpStatus === 403) {
    return { posts: [], hasNextPage: false, ok: false };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { posts: [], hasNextPage: false, ok: false };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { posts: [], hasNextPage: false, ok: false };
  }
  const result = (json as { result?: { posts?: unknown; hasNextPage?: unknown }; error?: unknown })
    .result;
  if (!result || (json as { error?: unknown }).error) {
    return { posts: [], hasNextPage: false, ok: false };
  }
  const rawPosts = Array.isArray(result.posts) ? result.posts : [];
  const posts: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of rawPosts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const post = entry as Record<string, unknown>;
    const id = postIdOf(post);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    posts.push(post);
  }
  return { posts, hasNextPage: result.hasNextPage === true, ok: true };
}

async function fetchAllBoardPosts(
  target: Window & typeof globalThis,
  slug: string,
): Promise<{ posts: Record<string, unknown>[]; complete: boolean }> {
  const newest = await fetchBoardListPage(target, slug, "newest");
  if (!newest.ok) {
    return { posts: [], complete: false };
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const post of newest.posts) {
    byId.set(postIdOf(post), post);
  }
  if (!newest.hasNextPage) {
    return { posts: [...byId.values()], complete: true };
  }

  await delay(LIST_GAP_MS);
  const oldest = await fetchBoardListPage(target, slug, "oldest");
  if (oldest.ok) {
    for (const post of oldest.posts) {
      const id = postIdOf(post);
      if (id && !byId.has(id)) {
        byId.set(id, post);
      }
    }
  }

  let skip = newest.posts.length;
  let guard = 0;
  while (skip > 0 && guard < 40) {
    guard += 1;
    await delay(LIST_GAP_MS);
    const page = await fetchBoardListPage(target, slug, "newest", skip);
    if (!page.ok || page.posts.length === 0) {
      break;
    }
    let added = 0;
    for (const post of page.posts) {
      const id = postIdOf(post);
      if (id && !byId.has(id)) {
        byId.set(id, post);
        added += 1;
      }
    }
    if (added === 0) {
      break;
    }
    skip += page.posts.length;
    if (!page.hasNextPage) {
      return { posts: [...byId.values()], complete: true };
    }
  }
  return { posts: [...byId.values()], complete: false };
}

async function syncBoardList(
  target: Window & typeof globalThis,
  viewer: string,
  slug: string,
  queue: Set<string>,
): Promise<void> {
  const { posts, complete } = await fetchAllBoardPosts(target, slug);
  if (posts.length === 0 && !complete) {
    return;
  }
  const existing = await getPrivatePostsByBoard(viewer, slug, target);
  const prevById = new Map(existing.map((post) => [post._id, post]));
  const seen = new Set<string>();
  const upserts: StoredPrivatePost[] = [];
  for (const listed of posts) {
    const id = postIdOf(listed);
    if (!id) {
      continue;
    }
    seen.add(id);
    const stored = mergeListed(prevById.get(id), listed, slug);
    upserts.push(stored);
    if (needsCommentFetch(stored)) {
      queue.add(id);
    } else {
      queue.delete(id);
    }
  }
  await putPrivatePosts(upserts, target);
  if (complete) {
    const stale = existing.map((post) => post._id).filter((id) => !seen.has(id));
    await deletePrivatePosts(stale, target);
    for (const id of stale) {
      queue.delete(id);
    }
  }
  await markBoardListSync(slug, complete, target);
}

async function fetchPostPage(
  target: Window & typeof globalThis,
  boardSlug: string,
  urlName: string,
): Promise<{ post: Record<string, unknown>; comments: Record<string, unknown>[] } | "missing" | "error"> {
  const nativeFetch = getNativeFetch(target);
  let response: Response;
  try {
    response = await nativeFetch(
      `${target.location.origin}/${boardSlug}/p/${encodeURIComponent(urlName)}`,
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "text/html" },
      },
    );
  } catch {
    return "error";
  }
  if (response.status === 404) {
    return "missing";
  }
  if (response.status < 200 || response.status >= 300) {
    return "error";
  }
  const html = await response.text();
  const data = parseCannyData(html);
  if (!data) {
    return "error";
  }
  const parsed = extractPostFromData(data, urlName);
  if (!parsed) {
    return "missing";
  }
  return parsed;
}

async function crawlComments(
  target: Window & typeof globalThis,
  viewer: string,
  queue: Set<string>,
): Promise<void> {
  const ids = [...queue];
  setStatus({
    phase: ids.length > 0 ? "comments" : "idle",
    commentDone: 0,
    commentTotal: ids.length,
  });
  let done = 0;
  for (const id of ids) {
    if (commentAbort) {
      break;
    }
    await waitVisible(target);
    const existing = await getPrivatePost(id, target);
    if (!existing) {
      queue.delete(id);
      done += 1;
      setStatus({ commentDone: done, commentTotal: queue.size + done });
      continue;
    }
    const result = await fetchPostPage(target, existing.boardSlug, existing.urlName);
    if (result === "missing") {
      await deletePrivatePosts([id], target);
      queue.delete(id);
    } else if (result !== "error") {
      const payload: Record<string, unknown> = {
        ...result.post,
        comments: result.comments,
      };
      const stored = toStoredPost(payload, existing.boardSlug, existing);
      stored.detailedAt = Date.now();
      stored.listedCommentCount =
        typeof payload.commentCount === "number" && Number.isFinite(payload.commentCount)
          ? payload.commentCount
          : result.comments.length;
      await putPrivatePosts([stored], target);
      queue.delete(id);
    }
    done += 1;
    setStatus({
      phase: "comments",
      commentDone: done,
      commentTotal: ids.length,
      postCount: await countPrivatePosts(viewer, target),
    });
    await setCommentQueue([...queue], target);
    await delay(COMMENT_GAP_MS);
  }
}

async function runIndexPass(
  target: Window & typeof globalThis,
  onUpdate?: () => void,
): Promise<void> {
  if (!viewerLoggedIn(target)) {
    setPrivateCoveredSlugs([]);
    setStatus({
      phase: "idle",
      postCount: 0,
      commentDone: 0,
      commentTotal: 0,
      boardCount: 0,
    });
    return;
  }
  const gateway = getGatewayCoveredSlugs();
  if (!gateway) {
    return;
  }
  const boards = readCannyBoards(target);
  const slugs = privateBoardSlugs(
    boards.map((board) => board.slug),
    gateway,
  );
  setPrivateCoveredSlugs(slugs);
  setStatus({ boardCount: slugs.length });
  if (slugs.length === 0) {
    setStatus({
      phase: "idle",
      postCount: 0,
      commentDone: 0,
      commentTotal: 0,
      boardCount: 0,
    });
    return;
  }

  const viewer = viewerId(target);
  await ensurePrivateStore(viewer, target);
  const queue = new Set(await getCommentQueue(target));

  setStatus({ phase: "listing", boardCount: slugs.length });
  for (const slug of slugs) {
    try {
      await syncBoardList(target, viewer, slug, queue);
    } catch (error) {
      console.warn("[vrcfb] private board list sync failed", slug, error);
    }
    setStatus({
      phase: "listing",
      postCount: await countPrivatePosts(viewer, target),
      boardCount: slugs.length,
    });
    await setCommentQueue([...queue], target);
    onUpdate?.();
    await delay(LIST_GAP_MS);
  }

  const remaining = [...queue];
  // Drop queue entries that are no longer stored (stale ids).
  const all = await getAllPrivatePosts(viewer, target);
  const known = new Set(all.map((post) => post._id));
  for (const id of remaining) {
    if (!known.has(id)) {
      queue.delete(id);
    }
  }
  await setCommentQueue([...queue], target);
  await crawlComments(target, viewer, queue);
  await setCommentQueue([...queue], target);
  setStatus({
    phase: "idle",
    postCount: await countPrivatePosts(viewer, target),
    commentDone: 0,
    commentTotal: queue.size,
    boardCount: slugs.length,
  });
  onUpdate?.();
}

function scheduleResync(
  target: Window & typeof globalThis,
  onUpdate?: () => void,
): void {
  if (resyncTimer !== null) {
    target.clearTimeout(resyncTimer);
  }
  resyncTimer = target.setTimeout(() => {
    resyncTimer = null;
    void runIndexPass(target, onUpdate).then(() => scheduleResync(target, onUpdate));
  }, LIST_RESYNC_MS);
}

/**
 * Discover private boards, cover them, and crawl lists then comments in the
 * background. Safe to call once; subsequent calls are ignored.
 */
export function startPrivateIndex(
  target: Window & typeof globalThis,
  onUpdate?: () => void,
): void {
  if (started) {
    return;
  }
  started = true;
  commentAbort = false;
  void (async () => {
    await waitForViewer(target, DATA_WAIT_MS);
    try {
      await runIndexPass(target, onUpdate);
    } catch (error) {
      console.warn("[vrcfb] private board index failed", error);
    }
    scheduleResync(target, onUpdate);
  })();
}
