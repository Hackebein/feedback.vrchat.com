---
name: vrchat-feedback-search
description: Search the public VRChat feedback corpus through the short agent HTTP API. Use when looking up feature requests, bug reports, or other feedback.vrchat.com posts.
---

# VRChat feedback search

Search the indexed public corpus at `https://vrchat-canny.hackebein.dev`. Cite the `url` from each response (`https://feedback.vrchat.com/{board}/p/{urlName}`). Report `status`, `score`, and `commentCount` only from the response.

## Search

`GET /api/agent/search?q={text}&board={board.urlName}&status={status}&limit={1-20}&page={n}`

- `board` and `status` are optional exact filters.
- Default `limit` is 10. Maximum is 20.
- A non-empty `q` returns relevance order, then newest. An empty `q` lists newest posts.
- Each hit includes `post_id`, `title`, `url`, `board`, `status`, `score`, `commentCount`, `created`, and a `snippet` of at most 200 characters.

Call `GET /api/agent/posts/{board}/{urlName}` only when the snippet is not enough to answer.

## One post

`GET /api/agent/posts/{board}/{urlName}`

- `details` is at most 4000 characters (`detailsTruncated`).
- `comments` is at most 8 public comments, pinned first, then newest. Each `value` is at most 500 characters (`valueTruncated`).
- `commentCount` is the full count and can be larger than `comments.length`.

## Contract

The search site HTML `<head>` links `rel="service-desc"` to `/openapi.json` and `rel="service-doc"` to `/openapi.html`. The same relations are on the `Link` response header. Use the two agent routes above. `/api/search` is the website InstantSearch payload and returns full posts.
