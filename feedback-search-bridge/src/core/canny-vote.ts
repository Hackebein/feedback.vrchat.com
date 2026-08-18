import { csrfTokenFromViewer } from "./private-boards";
import {
  hitPostId,
  recordViewerVote,
  viewerLoggedIn,
} from "./viewer-votes";

export function parseCannyVoteRequest(
  url: string,
  method: string,
  bodyText: string | undefined,
): { postID: string; score: 0 | 1 } | null {
  if (method.toUpperCase() !== "POST" || !bodyText) {
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url, "https://feedback.vrchat.com");
  } catch {
    return null;
  }
  if (!parsedUrl.pathname.endsWith("/api/posts/vote")) {
    return null;
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const postID = (body as { postID?: unknown }).postID;
  const score = (body as { score?: unknown }).score;
  if (typeof postID !== "string" || !postID.trim() || (score !== 0 && score !== 1)) {
    return null;
  }
  return { postID: postID.trim(), score };
}

function voteSucceeded(status: number, text: string): boolean {
  if (status < 200 || status >= 300) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return !(parsed as { error?: unknown }).error;
    }
  } catch {
    // Canny often returns the raw token `success`.
  }
  return true;
}

export function captureCannyVote(
  postID: string,
  score: 0 | 1,
  status: number,
  text: string,
): boolean {
  if (!voteSucceeded(status, text)) {
    return false;
  }
  recordViewerVote(postID, score);
  return true;
}

/** Cast or remove a vote through Canny's own `/api/posts/vote` endpoint. */
export async function submitCannyVote(
  target: Window & typeof globalThis,
  postId: string,
  score: 0 | 1,
  fetchFn: typeof fetch,
): Promise<boolean> {
  if (!postId || !viewerLoggedIn(target)) {
    return false;
  }
  const csrf = csrfTokenFromViewer(target);
  if (!csrf) {
    return false;
  }
  const response = await fetchFn(`${target.location.origin}/api/posts/vote`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ postID: postId, score, csrfToken: csrf }),
  });
  const text = await response.text();
  return captureCannyVote(postId, score, response.status, text);
}

export function postIdFromHit(hit: Record<string, unknown>): string {
  return hitPostId(hit);
}
