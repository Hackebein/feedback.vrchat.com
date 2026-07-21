# feedback.vrchat.com

---

## Search API

| Item | Value |
|------|--------|
| URL | `https://feedback.vrchat.com/api/posts/get` |
| Method | `POST` |
| `Content-Type` | `application/json` |

### Body fields

| Field | What to send |
|-------|----------------|
| `pages` | **Always `50`** (up to 500 posts) |
| `textSearch` | Your search query |
| `boardURLNames` | Board slugs to search, e.g. `["feature-requests"]` or several at once |

Optional `sort` (omit for default search ranking):

| Value | Order |
|-------|--------|
| *(omit)* | Default match ranking |
| `"newest"` / `"created"` | Newest first (same result) |
| `"oldest"` | Oldest first |
| `"score"` | Vote score |
| `"trendingScore"` | Trending score |

Each request returns at most 500 posts. When more matches exist (`hasNextPage: true`), varying `sort` reorders the result set and can surface posts that fall outside the first 500 under another ordering.

### Example

```bash
curl -sS -X POST 'https://feedback.vrchat.com/api/posts/get' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: Mozilla/5.0 (compatible; FeedbackSearch/1.0)' \
  --data-binary '{
    "pages": 50,
    "textSearch": "avatar performance",
    "boardURLNames": ["feature-requests"]
  }'
```

### Response

```json
{
  "result": {
    "hasNextPage": true,
    "posts": [ /* … */ ]
  }
}
```

- **`posts`:** matches (`urlName`, `title`, `details`, `board`, …)
- **`hasNextPage`:** `true` means more than 500 matched

---

## Detail URL

Each post maps to a stable page:

```
https://feedback.vrchat.com/{board}/p/{urlName}
```

| Part | From post | Example |
|------|-----------|---------|
| `board` | `post.board.urlName` | `feature-requests` |
| `urlName` | `post.urlName` | `avatar-performance-versions` |

**Example**

```
https://feedback.vrchat.com/feature-requests/p/avatar-performance-versions
```

From each post in the search response:

```js
const url = `https://feedback.vrchat.com/${post.board.urlName}/p/${post.urlName}`;
```

No query parameters are required.

---
