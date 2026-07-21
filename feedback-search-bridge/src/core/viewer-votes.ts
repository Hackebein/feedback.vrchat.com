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
 */

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

/** True when the logged-in viewer is among a hit's voters. */
export function hitVotedByViewer(
  target: Window & typeof globalThis,
  hit: Record<string, unknown>,
): boolean {
  const id = viewerId(target);
  return id !== "" && voterIds(hit).has(id);
}

/**
 * postId -> vote (1) for every hit the viewer has voted on. Synchronous; reads
 * the voters already present in the search response. Empty when logged out.
 */
export function buildViewerVoteMap(
  target: Window & typeof globalThis,
  hits: unknown,
): Map<string, number> {
  const votes = new Map<string, number>();
  const id = viewerId(target);
  if (!id || !Array.isArray(hits)) {
    return votes;
  }
  for (const raw of hits) {
    const hit = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (voterIds(hit).has(id)) {
      const postId = idOf(hit);
      if (postId) {
        votes.set(postId, 1);
      }
    }
  }
  return votes;
}

export { idOf as hitPostId };
