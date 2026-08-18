/**
 * Viewer vote detection, gateway-native. Every gateway hit carries a `voters`
 * array (each entry has `_id` / `aliasID`); the logged-in viewer's id lives in
 * Canny's store at `__data.viewer._id`. Matching the two lets us restore the
 * "you voted" highlight with NO extra network calls — Canny's own
 * `/api/posts/getOne` requires a CSRF token and firing one per post floods the
 * API, so we avoid it entirely.
 *
 * Caveat: the index stores a capped voters list for very high-vote posts, so a
 * vote can be missed there; this mirrors what the "Voted by" facet can see.
 *
 * After a click, Canny reloads the list. We serve that list from the gateway,
 * which still has the old voters/`viewerVote`, so the highlight would revert.
 * A session overlay records votes we observe (and roadmap clicks) and is
 * applied on every mapped hit until the index agrees.
 */

import { STORAGE_KEYS } from "./config";
import type { BridgeStorage } from "./types";

type VoteOverlay = { vote: number; delta: number };

const overlay = new Map<string, VoteOverlay>();
const knownVotes = new Map<string, number>();

let hydratedViewer = "";
let persistQueue: Promise<void> = Promise.resolve();
let voteStorage: BridgeStorage | undefined;
let voteTarget: (Window & typeof globalThis) | undefined;

export function viewerLoggedIn(target?: Window & typeof globalThis): boolean {
  const viewer = (target as unknown as {
    __data?: { viewer?: { loggedOut?: boolean; _id?: string } };
  } | undefined)?.__data?.viewer;
  return !!viewer && viewer.loggedOut !== true && typeof viewer._id === "string";
}

export function viewerId(target?: Window & typeof globalThis): string {
  return (
    (target as unknown as { __data?: { viewer?: { _id?: string } } } | undefined)
      ?.__data?.viewer?._id ?? ""
  );
}

export function viewerName(target?: Window & typeof globalThis): string {
  const viewer = (target as unknown as {
    __data?: { viewer?: { name?: string; fullName?: string } };
  } | undefined)?.__data?.viewer;
  const name = typeof viewer?.name === "string" ? viewer.name.trim() : "";
  if (name) {
    return name;
  }
  const fullName = typeof viewer?.fullName === "string" ? viewer.fullName.trim() : "";
  return fullName;
}

/** Collected voter ids (`_id` and `aliasID`) for a gateway hit. */
function voterIds(hit: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const voters = hit.voters;
  if (Array.isArray(voters)) {
    for (const entry of voters) {
      const voter = entry as { _id?: unknown; aliasID?: unknown };
      if (typeof voter._id === "string") {
        ids.add(voter._id);
      }
      if (typeof voter.aliasID === "string") {
        ids.add(voter.aliasID);
      }
    }
  }
  return ids;
}

function idOf(hit: Record<string, unknown>): string {
  for (const key of ["objectID", "post_id", "_id"] as const) {
    const value = hit[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function inferredVote(target: Window & typeof globalThis, hit: Record<string, unknown>): number {
  const id = viewerId(target);
  return id !== "" && voterIds(hit).has(id) ? 1 : 0;
}

function payloadVote(hit: Record<string, unknown>): number {
  return hit.viewerVote === 1 ? 1 : 0;
}

function storageKey(id: string): string {
  return `${STORAGE_KEYS.viewerVotes}:${id}`;
}

function persistVotes(): void {
  const storage = voteStorage;
  const target = voteTarget;
  if (!storage || !target) {
    return;
  }
  const id = viewerId(target);
  if (!id) {
    return;
  }
  const record: Record<string, number> = {};
  for (const [postId, entry] of overlay) {
    record[postId] = entry.vote;
  }
  persistQueue = persistQueue.then(() => storage.set(storageKey(id), record));
}

/**
 * Load persisted votes for this viewer. Safe to call often; hydrates once per
 * viewer id. Persisted entries restore the highlight only (score delta stays 0
 * until a live click this session).
 */
export async function hydrateViewerVotes(
  storage: BridgeStorage,
  target: Window & typeof globalThis,
): Promise<void> {
  voteStorage = storage;
  voteTarget = target;
  const id = viewerId(target);
  if (!id) {
    return;
  }
  if (hydratedViewer === id) {
    return;
  }
  if (hydratedViewer) {
    overlay.clear();
    knownVotes.clear();
  }
  hydratedViewer = id;
  const record = await storage.get<Record<string, number>>(storageKey(id), {});
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return;
  }
  for (const [postId, vote] of Object.entries(record)) {
    if (!postId || (vote !== 0 && vote !== 1)) {
      continue;
    }
    if (!overlay.has(postId)) {
      overlay.set(postId, { vote, delta: 0 });
    }
    knownVotes.set(postId, vote);
  }
}

/** Record a vote the viewer just cast (`score` is 0 or 1 from Canny). */
export function recordViewerVote(postId: string, score: number): void {
  if (!postId || (score !== 0 && score !== 1)) {
    return;
  }
  const prev = overlay.get(postId)?.vote ?? knownVotes.get(postId) ?? 0;
  const prevDelta = overlay.get(postId)?.delta ?? 0;
  overlay.set(postId, { vote: score, delta: prevDelta + (score - prev) });
  knownVotes.set(postId, score);
  persistVotes();
}

export function viewerScoreDelta(postId: string): number {
  return overlay.get(postId)?.delta ?? 0;
}

/** True when the logged-in viewer is among a hit's voters, or our overlay says so. */
export function hitVotedByViewer(
  target: Window & typeof globalThis,
  hit: Record<string, unknown>,
): boolean {
  const postId = idOf(hit);
  const overlayVote = postId ? overlay.get(postId)?.vote : undefined;
  if (overlayVote === 0 || overlayVote === 1) {
    return overlayVote === 1;
  }
  return inferredVote(target, hit) === 1 || payloadVote(hit) === 1;
}

export function hitDisplayScore(hit: Record<string, unknown>): number {
  const score = typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 0;
  const postId = idOf(hit);
  return score + (postId ? viewerScoreDelta(postId) : 0);
}

/**
 * postId -> vote (0 or 1) for hits whose voted state we know. Includes overlay
 * zeros so an unvote survives the next gateway list payload.
 */
export function buildViewerVoteMap(
  target: Window & typeof globalThis,
  hits: unknown,
): Map<string, number> {
  const votes = new Map<string, number>();
  const id = viewerId(target);
  if (!Array.isArray(hits)) {
    return votes;
  }

  let overlayDirty = false;
  for (const raw of hits) {
    const hit = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const postId = idOf(hit);
    if (!postId) {
      continue;
    }
    const inferred = id ? inferredVote(target, hit) : 0;
    const fromPayload = payloadVote(hit);
    const entry = overlay.get(postId);
    if (entry && entry.vote === inferred) {
      overlay.delete(postId);
      overlayDirty = true;
    }
    const vote = overlay.get(postId)?.vote ?? (inferred || fromPayload);
    knownVotes.set(postId, vote);
    if (vote === 1 || overlay.has(postId)) {
      votes.set(postId, vote);
    }
  }
  if (overlayDirty) {
    persistVotes();
  }
  return votes;
}

/** Apply overlay vote + in-session score delta onto a mapped Canny post. */
export function applyViewerVoteState(
  post: Record<string, unknown>,
  viewerVotes?: Map<string, number>,
): void {
  const id =
    (typeof post._id === "string" && post._id) ||
    (typeof post.objectID === "string" && post.objectID) ||
    (typeof post.post_id === "string" && post.post_id) ||
    "";
  if (!id) {
    return;
  }
  const vote = viewerVotes?.get(id);
  if (typeof vote === "number") {
    post.viewerVote = vote;
  }
  const delta = viewerScoreDelta(id);
  if (delta !== 0 && typeof post.score === "number" && Number.isFinite(post.score)) {
    post.score = post.score + delta;
  }
}

export function resetVoteOverlay(): void {
  overlay.clear();
  knownVotes.clear();
  hydratedViewer = "";
}

export { idOf as hitPostId };
