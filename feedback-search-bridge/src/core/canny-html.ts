const UNDEF_RE = /(?<=[:,\[])\s*undefined\s*(?=[,}\]])/g;

/**
 * Extract `window.__data = {...}` from a Canny HTML page.
 *
 * Canny embeds the Redux store as a JS object literal with a handful of
 * `undefined` values. Those are rewritten to `null` and the object is
 * brace-matched so we don't depend on a specific terminator.
 */
export function parseCannyData(html: string): Record<string, unknown> | null {
  if (!html) {
    return null;
  }
  const marker = /window\.__data\s*=\s*/;
  if (!marker.test(html)) {
    return null;
  }
  const sanitized = html.replace(UNDEF_RE, "null");
  const match = marker.exec(sanitized);
  if (!match) {
    return null;
  }
  const start = match.index + match[0].length;
  if (start >= sanitized.length || sanitized[start] !== "{") {
    return null;
  }
  const end = braceEnd(sanitized, start);
  if (end < 0) {
    return null;
  }
  try {
    return JSON.parse(sanitized.slice(start, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function braceEnd(source: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

export type ParsedPostPage = {
  post: Record<string, unknown>;
  comments: Record<string, unknown>[];
};

/**
 * Pull the named post and its activity comments from parsed `__data`.
 */
export function extractPostFromData(
  data: Record<string, unknown>,
  urlName: string,
): ParsedPostPage | null {
  const posts = data.posts;
  if (!posts || typeof posts !== "object" || Array.isArray(posts)) {
    return null;
  }
  let post: Record<string, unknown> | null = null;
  for (const slugs of Object.values(posts as Record<string, unknown>)) {
    if (!slugs || typeof slugs !== "object" || Array.isArray(slugs)) {
      continue;
    }
    const found = (slugs as Record<string, unknown>)[urlName];
    if (found && typeof found === "object" && !Array.isArray(found)) {
      post = found as Record<string, unknown>;
      break;
    }
  }
  if (!post) {
    return null;
  }
  if (post.notFound === true || post.deletedAt) {
    return null;
  }
  const pid = typeof post._id === "string" ? post._id : "";
  const comments = pid ? commentsFromActivity(data, pid) : [];
  return { post, comments };
}

function commentsFromActivity(
  data: Record<string, unknown>,
  postId: string,
): Record<string, unknown>[] {
  const activityRoot = data.postsActivity;
  if (!activityRoot || typeof activityRoot !== "object" || Array.isArray(activityRoot)) {
    return [];
  }
  const activity = (activityRoot as Record<string, unknown>)[postId];
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) {
    return [];
  }
  const raw = (activity as { comments?: unknown }).comments;
  let items: unknown[] = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (raw && typeof raw === "object") {
    items = Object.values(raw);
  }
  const comments: Record<string, unknown>[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const comment = entry as Record<string, unknown>;
    if (comment.deleted === true || comment.postDeleted === true) {
      continue;
    }
    comments.push(comment);
  }
  comments.sort((a, b) => {
    const left = typeof a.created === "string" ? a.created : "";
    const right = typeof b.created === "string" ? b.created : "";
    return left.localeCompare(right);
  });
  return comments;
}
