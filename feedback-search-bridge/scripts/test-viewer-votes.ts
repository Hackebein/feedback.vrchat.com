import assert from "node:assert/strict";
import {
  applyViewerVoteState,
  buildViewerVoteMap,
  hitDisplayScore,
  hitVotedByViewer,
  recordViewerVote,
  resetVoteOverlay,
  viewerScoreDelta,
} from "../src/core/viewer-votes";
import { captureCannyVote, parseCannyVoteRequest } from "../src/core/canny-vote";

resetVoteOverlay();

const viewer = {
  __data: { viewer: { _id: "user-1", loggedOut: false } },
} as unknown as Window & typeof globalThis;

const hit = {
  _id: "post-1",
  score: 10,
  viewerVote: 0,
  voters: [{ _id: "someone-else" }],
};

assert.equal(hitVotedByViewer(viewer, hit), false);
assert.equal(hitDisplayScore(hit), 10);

recordViewerVote("post-1", 1);
assert.equal(hitVotedByViewer(viewer, hit), true);
assert.equal(viewerScoreDelta("post-1"), 1);
assert.equal(hitDisplayScore(hit), 11);

const mapped = buildViewerVoteMap(viewer, [hit]);
assert.equal(mapped.get("post-1"), 1);

const post: Record<string, unknown> = { ...hit };
applyViewerVoteState(post, mapped);
assert.equal(post.viewerVote, 1);
assert.equal(post.score, 11);

recordViewerVote("post-1", 0);
assert.equal(hitVotedByViewer(viewer, hit), false);
assert.equal(hitDisplayScore(hit), 10);
assert.equal(buildViewerVoteMap(viewer, [hit]).has("post-1"), false);

resetVoteOverlay();

const alreadyVoted = {
  _id: "post-2",
  score: 5,
  viewerVote: 0,
  voters: [{ _id: "user-1" }, { aliasID: "user-1" }],
};
assert.equal(hitVotedByViewer(viewer, alreadyVoted), true);
const inferred = buildViewerVoteMap(viewer, [alreadyVoted]);
assert.equal(inferred.get("post-2"), 1);

recordViewerVote("post-2", 0);
assert.equal(hitVotedByViewer(viewer, alreadyVoted), false);
assert.equal(hitDisplayScore(alreadyVoted), 4);
const unvoted = { ...alreadyVoted };
applyViewerVoteState(unvoted, buildViewerVoteMap(viewer, [alreadyVoted]));
assert.equal(unvoted.viewerVote, 0);
assert.equal(unvoted.score, 4);

resetVoteOverlay();
recordViewerVote("post-2", 1);
buildViewerVoteMap(viewer, [alreadyVoted]);
assert.equal(viewerScoreDelta("post-2"), 0);
assert.equal(hitVotedByViewer(viewer, alreadyVoted), true);

resetVoteOverlay();

assert.deepEqual(
  parseCannyVoteRequest(
    "/api/posts/vote",
    "POST",
    JSON.stringify({ postID: "abc", score: 1, csrfToken: "t" }),
  ),
  { postID: "abc", score: 1 },
);
assert.equal(
  parseCannyVoteRequest("/api/posts/get", "POST", JSON.stringify({ postID: "abc", score: 1 })),
  null,
);
assert.equal(
  parseCannyVoteRequest("/api/posts/vote", "GET", JSON.stringify({ postID: "abc", score: 1 })),
  null,
);

assert.equal(captureCannyVote("p3", 1, 200, "success"), true);
assert.equal(hitVotedByViewer(viewer, { _id: "p3", score: 1 }), true);
assert.equal(captureCannyVote("p3", 1, 200, JSON.stringify({ error: "slow down" })), false);
assert.equal(captureCannyVote("p3", 0, 429, "success"), false);

const privateHit = {
  _id: "priv",
  score: 3,
  viewerVote: 1,
  voters: [],
};
resetVoteOverlay();
assert.equal(hitVotedByViewer(viewer, privateHit), true);
assert.equal(buildViewerVoteMap(viewer, [privateHit]).get("priv"), 1);

console.info("viewer-votes tests passed");
