import Client from "@searchkit/instantsearch-client";
import {
  Fragment,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ClearRefinements,
  Configure,
  CurrentRefinements,
  Highlight,
  Hits,
  InstantSearch,
  Pagination,
  RangeInput,
  RefinementList,
  SearchBox,
  SortBy,
  Stats,
  ToggleRefinement,
  useInstantSearch,
  useRange,
  useSearchBox,
} from "react-instantsearch";
import type { RefinementListItem } from "instantsearch.js/es/connectors/refinement-list/connectRefinementList";
import { AttachmentTextView } from "./AttachmentTextView";
import { EmbeddedImageView } from "./EmbeddedImageView";
import { aiCategoryDescription, aiCategoryName } from "./featureTree";
import { MarkdownText } from "./MarkdownText";
import { detectVideoEmbed } from "./videoEmbed";
import { VideoEmbedView } from "./VideoEmbedView";

function tokenizeQuery(q: string): string[] {
  if (!q) return [];
  const out: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const trimmed = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function useQueryTerms(): string[] {
  const { query } = useSearchBox();
  return useMemo(() => tokenizeQuery(query), [query]);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightInline(text: string, terms: string[]): ReactNode {
  if (!text) return text;
  const filtered = terms.filter((t) => t.length > 0);
  if (filtered.length === 0) return text;
  const pattern = new RegExp(
    `(${filtered.map(escapeRegExp).join("|")})`,
    "gi",
  );
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    i % 2 === 1 ? <mark key={i}>{part}</mark> : part,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function msToDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function EpochMsRangeInput({ attribute }: { attribute: string }) {
  const { start, range, refine, canRefine } = useRange({
    attribute,
    precision: 0,
  });
  const rmin = range.min;
  const rmax = range.max;
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");

  useEffect(() => {
    const [low, high] = start;
    const hasFrom =
      typeof low === "number" &&
      Number.isFinite(low) &&
      low !== -Infinity &&
      rmin !== undefined &&
      low !== rmin;
    const hasTo =
      typeof high === "number" &&
      Number.isFinite(high) &&
      high !== Infinity &&
      rmax !== undefined &&
      high !== rmax;
    setFromLocal(hasFrom ? msToDatetimeLocalValue(low) : "");
    setToLocal(hasTo ? msToDatetimeLocalValue(high) : "");
  }, [start, rmin, rmax]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedFrom = fromLocal.trim();
    const trimmedTo = toLocal.trim();
    const loMs = trimmedFrom ? new Date(trimmedFrom).getTime() : undefined;
    const hiMs = trimmedTo ? new Date(trimmedTo).getTime() : undefined;
    const lowOk =
      loMs !== undefined && Number.isFinite(loMs) ? Math.floor(loMs) : undefined;
    const highOk =
      hiMs !== undefined && Number.isFinite(hiMs) ? Math.floor(hiMs) : undefined;
    if (
      lowOk !== undefined &&
      highOk !== undefined &&
      lowOk > highOk
    ) {
      return;
    }
    refine([lowOk, highOk]);
  }

  function onResetClick() {
    setFromLocal("");
    setToLocal("");
    refine([undefined, undefined]);
  }

  return (
    <form className="epoch-ms-range-form" onSubmit={onSubmit}>
      <div className="epoch-ms-range-inputs">
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">From</span>
          <input
            type="datetime-local"
            step={60}
            className="epoch-ms-range-datetime"
            value={fromLocal}
            disabled={!canRefine}
            onChange={(e) => setFromLocal(e.target.value)}
          />
        </label>
        <span aria-hidden className="epoch-ms-range-sep">
          —
        </span>
        <label className="epoch-ms-range-label">
          <span className="epoch-ms-range-label-text">To</span>
          <input
            type="datetime-local"
            step={60}
            className="epoch-ms-range-datetime"
            disabled={!canRefine}
            value={toLocal}
            onChange={(e) => setToLocal(e.target.value)}
          />
        </label>
      </div>
      <div className="epoch-ms-range-actions">
        <button type="submit" className="epoch-ms-range-submit" disabled={!canRefine}>
          Apply
        </button>
        <button
          type="button"
          className="epoch-ms-range-reset"
          disabled={!canRefine}
          onClick={onResetClick}
        >
          Clear
        </button>
      </div>
    </form>
  );
}

const indexName = "feedback-posts";

const LUCENE_MODE_STORAGE_KEY = "feedback-search:luceneMode";

function readStoredLuceneMode(): boolean {
  try {
    return typeof localStorage !== "undefined" &&
      localStorage.getItem(LUCENE_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** POST /api/search; throws on HTTP error so InstantSearch exposes status `error`. */
function createFeedbackSearchClient(apiUrl: string) {
  const inner = Client({ url: apiUrl });
  async function fetchSearchJson(body: unknown) {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(
          response.ok
            ? `Invalid JSON from search: ${text.slice(0, 200)}`
            : `${response.status} ${response.statusText} — ${text.slice(0, 500)}`,
        );
      }
    }
    if (!response.ok) {
      const o = parsed as { message?: string; detail?: unknown } | undefined;
      const msg = typeof o?.message === "string" ? o.message : `Search failed (${response.status})`;
      const err = new Error(msg) as Error & { statusCode?: number; detail?: unknown };
      err.statusCode = response.status;
      err.detail = o?.detail ?? (text || undefined);
      throw err;
    }
    return parsed;
  }
  return Object.assign(inner, {
    async search(requests: unknown) {
      return fetchSearchJson(requests);
    },
  });
}

type LuceneAttrRow = { field: string; kind: string; example: string };

const LUCENE_ATTRIBUTE_ROWS: LuceneAttrRow[] = [
  { field: "title", kind: "text", example: `title:avatar` },
  { field: "details", kind: "text", example: `details:"network lag"` },
  { field: "combined_text", kind: "text", example: `combined_text:performance` },
  { field: "author.name", kind: "text", example: `author.name:Alice` },
  { field: "status", kind: "keyword", example: `status:open` },
  { field: "board.urlName", kind: "keyword", example: `board.urlName:bug-reports` },
  { field: "board.name", kind: "text", example: `board.name:bug` },
  { field: "board.name.keyword", kind: "keyword", example: `board.name.keyword:"Feature Requests"` },
  { field: "category.name", kind: "text", example: `category.name:sdk` },
  { field: "category.name.keyword", kind: "keyword", example: `category.name.keyword:SDK` },
  { field: "author.name.keyword", kind: "keyword", example: `author.name.keyword:"Jane Doe"` },
  { field: "score", kind: "numeric", example: `score:[10 TO *]` },
  { field: "maxScore", kind: "numeric", example: `maxScore:[100 TO *]` },
  { field: "commentCount", kind: "numeric", example: `commentCount:[1 TO 50]` },
  { field: "mergeCount", kind: "numeric", example: `mergeCount:[1 TO *]` },
  { field: "trendingScore", kind: "numeric", example: `trendingScore:[500 TO *]` },
  {
    field: "voteSettings.highEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.highEngagement:true`,
  },
  {
    field: "voteSettings.moderateEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.moderateEngagement:true`,
  },
  {
    field: "voteSettings.lowEngagement",
    kind: "keyword/bool-like",
    example: `voteSettings.lowEngagement:true`,
  },
  {
    field: "created",
    kind: "date",
    example: `created:["2025-01-01" TO "2026-01-01"]`,
  },
  {
    field: "updatedAt",
    kind: "date",
    example: `updatedAt:["2025-01-01" TO "*"]`,
  },
  {
    field: "statusChanged",
    kind: "date",
    example: `statusChanged:["2025-01-01" TO "*"]`,
  },
  { field: "comments.value", kind: "text", example: `comments.value:"network lag"` },
  { field: "comments.author.name", kind: "text", example: `comments.author.name:Alice` },
  {
    field: "comments.author.name.keyword",
    kind: "keyword",
    example: `comments.author.name.keyword:"Jane Doe"`,
  },
  { field: "comments.pinned", kind: "keyword", example: `comments.pinned:true` },
  {
    field: "comments.likeCount",
    kind: "numeric",
    example: `comments.likeCount:[1 TO *]`,
  },
  {
    field: "comments.created",
    kind: "date",
    example: `comments.created:["2025-01-01" TO "*"]`,
  },
  {
    field: "aiCategories",
    kind: "text",
    example: `aiCategories:groups`,
  },
  {
    field: "aiCategories.keyword",
    kind: "keyword",
    example: `aiCategories.keyword:"groups.calendar"`,
  },
  {
    field: "aiTaggedAt",
    kind: "date",
    example: `aiTaggedAt:["2025-01-01" TO "*"]`,
  },
];

function LuceneAttributesPanel({ onClose }: { onClose: () => void }) {
  return (
    <aside className="lucene-attributes" aria-labelledby="lucene-attributes-heading">
      <button
        type="button"
        className="lucene-attributes-close"
        aria-label="Hide field reference"
        onClick={onClose}
      >
        ×
      </button>
      <div className="lucene-attributes-intro">
        <h2 id="lucene-attributes-heading" className="lucene-attributes-heading">
          Field reference
        </h2>
        <p className="lucene-attributes-note">
          <code className="lucene-inline-code">comments.*</code> clause matches if <strong>any</strong> single comment satisfies it. Bare terms target the default text fields (combined title, body, author name).
        </p>
      </div>
      <ul className="lucene-attributes-list">
        {LUCENE_ATTRIBUTE_ROWS.map((row) => (
          <li key={row.field} className="lucene-attributes-item">
            <div className="lucene-attributes-field">
              <span className="lucene-sr-label">Field</span>
              <code className="lucene-field-name">{row.field}</code>
            </div>
            <div className="lucene-attributes-kind">{row.kind}</div>
            <div className="lucene-attributes-example">
              <span className="lucene-sr-label">Example</span>
              <code className="lucene-example-code">{row.example}</code>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function LuceneSearchError() {
  const { status, error } = useInstantSearch({ catchError: true });

  if (status !== "error") {
    return null;
  }

  const message = error?.message ?? "Unknown error";
  const ext = error as Error & { detail?: unknown };
  const detailStr =
    ext.detail === undefined
      ? ""
      : typeof ext.detail === "string"
        ? ext.detail
        : `\n${JSON.stringify(ext.detail, null, 2)}`;

  return (
    <div className="lucene-search-error" role="alert">
      <strong>Search error</strong>
      <pre className="lucene-search-error-body">
        {message}
        {detailStr}
      </pre>
    </div>
  );
}

const CANNY_ORIGIN = "https://feedback.vrchat.com";

function cannyPostUrl(
  boardSlug: string | undefined,
  urlName: string | undefined,
): string | undefined {
  if (!boardSlug || !urlName) {
    return undefined;
  }
  return `${CANNY_ORIGIN}/${encodeURIComponent(boardSlug)}/p/${encodeURIComponent(urlName)}`;
}

function formatCommentLabel(count: number): string {
  return count === 1 ? "1 comment" : `${count} comments`;
}

function formatCreatedAt(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return undefined;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function readString(obj: unknown, key: string): string {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return "";
  }
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

const CANNY_USER_ID_RE = /^[0-9a-f]{24}$/;
/** Canny encodes `@DisplayName` as `@{mongoId|full_name}` in post/comment bodies. */
const CANNY_MENTION_TOKEN_RE = /@\{([0-9a-f]{24})\|full_name\}/g;

function registerCannyUser(
  map: Map<string, string>,
  user: unknown,
): void {
  if (!user || typeof user !== "object" || Array.isArray(user)) {
    return;
  }
  const o = user as Record<string, unknown>;
  const idRaw = typeof o._id === "string" ? o._id.trim() : "";
  if (!idRaw || !CANNY_USER_ID_RE.test(idRaw)) {
    return;
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name || map.has(idRaw)) {
    return;
  }
  map.set(idRaw, name);
}

function appendUsersFromComments(
  map: Map<string, string>,
  comments: unknown,
): void {
  if (!Array.isArray(comments)) {
    return;
  }
  for (const raw of comments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    registerCannyUser(map, c.author);
    const mentioned = c.mentionedUsers;
    if (Array.isArray(mentioned)) {
      for (const m of mentioned) {
        registerCannyUser(map, m);
      }
    }
  }
}

/** Aggregate Canny `_id` → display name from everything shipped on this hit. */
function buildCannyUserNameMap(hit: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  registerCannyUser(map, hit.author);
  registerCannyUser(map, hit.by);
  registerCannyUser(map, hit.updatedBy);
  const voters = hit.voters;
  if (Array.isArray(voters)) {
    for (const v of voters) {
      registerCannyUser(map, v);
    }
  }
  appendUsersFromComments(map, hit.comments);
  const pinned = hit.pinnedComment;
  if (pinned && typeof pinned === "object" && !Array.isArray(pinned)) {
    const p = pinned as Record<string, unknown>;
    registerCannyUser(map, p.author);
    const mentioned = p.mentionedUsers;
    if (Array.isArray(mentioned)) {
      for (const m of mentioned) {
        registerCannyUser(map, m);
      }
    }
  }
  return map;
}

function substituteCannyMentions(
  text: string,
  userNameById: Map<string, string>,
): string {
  if (!text || userNameById.size === 0) {
    return text;
  }
  return text.replace(CANNY_MENTION_TOKEN_RE, (fullMatch, oid: string) => {
    const name = userNameById.get(oid);
    return name !== undefined ? `@${name}` : fullMatch;
  });
}

function readPostAuthorName(hit: Record<string, unknown>): string {
  return readString(hit.author, "name");
}

function readPostAuthorAvatarUrl(hit: Record<string, unknown>): string {
  return readString(hit.author, "avatarURL");
}

function AuthorAvatar({
  avatarUrl,
  name,
}: {
  avatarUrl: string;
  name: string;
}) {
  if (avatarUrl) {
    return (
      <img
        className="author-avatar"
        src={avatarUrl}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span className="author-avatar author-avatar-placeholder" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function readBoardSlug(hit: Record<string, unknown>): string | undefined {
  const slug = readString(hit.board, "urlName");
  return slug || undefined;
}

function readBoardName(hit: Record<string, unknown>): string | undefined {
  const name = readString(hit.board, "name");
  return name || undefined;
}

type CommentLike = Record<string, unknown> & {
  _id?: string;
  parentID?: unknown;
  value?: string;
  mergeID?: string;
  statusChangeID?: string;
  statusChangeNewStatus?: string;
  mergedPostTitle?: string;
  mergedPostDetails?: string;
  created?: string;
  author?: Record<string, unknown>;
  imageURLs?: unknown;
  files?: unknown;
  likeCount?: unknown;
  pinned?: unknown;
  internal?: unknown;
  private?: unknown;
  deleted?: unknown;
  spam?: unknown;
};

function readVisibleComments(raw: unknown): CommentLike[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const visible: CommentLike[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      continue;
    }
    const obj = c as CommentLike;
    if (obj.deleted === true || obj.spam === true) {
      continue;
    }
    visible.push(obj);
  }
  visible.sort(compareCommentsByCreated);
  return visible;
}

function compareCommentsByCreated(a: CommentLike, b: CommentLike): number {
  const ta = typeof a.created === "string" ? Date.parse(a.created) : NaN;
  const tb = typeof b.created === "string" ? Date.parse(b.created) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return ta - tb;
}

function readCommentParentId(c: CommentLike): string | undefined {
  const raw = c.parentID;
  if (raw === null || raw === undefined) {
    return undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  return undefined;
}

type CommentThreadNode = {
  comment: CommentLike;
  replies: CommentThreadNode[];
};

function buildCommentThreadTree(visible: CommentLike[]): CommentThreadNode[] {
  const sorted = [...visible].sort(compareCommentsByCreated);
  const idSet = new Set<string>();
  for (const c of sorted) {
    if (typeof c._id === "string" && c._id) {
      idSet.add(c._id);
    }
  }
  const childrenMap = new Map<string, CommentLike[]>();
  for (const c of sorted) {
    const pid = readCommentParentId(c);
    if (pid && idSet.has(pid)) {
      let bucket = childrenMap.get(pid);
      if (!bucket) {
        bucket = [];
        childrenMap.set(pid, bucket);
      }
      bucket.push(c);
    }
  }
  for (const bucket of childrenMap.values()) {
    bucket.sort(compareCommentsByCreated);
  }
  const topLevel = sorted.filter((c) => {
    const pid = readCommentParentId(c);
    return !pid || !idSet.has(pid);
  });

  function toNode(c: CommentLike): CommentThreadNode {
    const id = typeof c._id === "string" ? c._id : "";
    const rawReplies = id ? (childrenMap.get(id) ?? []) : [];
    return {
      comment: c,
      replies: rawReplies.map(toNode),
    };
  }

  return topLevel.map(toNode);
}

function readCommentBody(c: CommentLike): string {
  const raw =
    typeof c.value === "string" && c.value.trim() ? c.value.trim() : "";
  if (raw) {
    return raw;
  }
  const mergedTitle = readString(c, "mergedPostTitle");
  const mergedDetails = readString(c, "mergedPostDetails");
  const mergedParts = [mergedTitle, mergedDetails].filter(Boolean);
  if (mergedParts.length > 0) {
    return mergedParts.join("\n\n");
  }
  return "";
}

function readImageUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v);
  }
  return out;
}

type AttachmentFile = { name: string; url: string };

function readFileAttachments(raw: unknown): AttachmentFile[] {
  if (!Array.isArray(raw)) return [];
  const out: AttachmentFile[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || Array.isArray(f)) continue;
    const url = readString(f, "url");
    if (!url) continue;
    const name = readString(f, "name") || url;
    out.push({ name, url });
  }
  return out;
}

function urlBasename(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ?? url;
  } catch {
    return url;
  }
}

function readPositiveInt(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function isTextFile(f: AttachmentFile): boolean {
  return /\.txt(\?|#|$)/i.test(f.url) || /\.txt$/i.test(f.name);
}

function Attachments({
  imageUrls,
  files,
}: {
  imageUrls: string[];
  files: AttachmentFile[];
}) {
  const tiles: ReactNode[] = [];

  for (const url of imageUrls) {
    const embed = detectVideoEmbed(url);
    const basename = urlBasename(url);
    tiles.push(
      <li key={`img-${url}`} className="attachment-tile">
        {embed ? (
          <VideoEmbedView
            embed={embed}
            downloadName={embed.kind === "video" ? basename : undefined}
          />
        ) : (
          <EmbeddedImageView
            src={url}
            alt=""
            className="attachment-image-wrap"
            downloadName={basename}
          />
        )}
      </li>,
    );
  }

  for (const f of files) {
    const embed = detectVideoEmbed(f.url);
    let body: ReactNode;
    if (embed) {
      body = (
        <VideoEmbedView
          embed={embed}
          title={f.name}
          downloadName={embed.kind === "video" ? f.name : undefined}
        />
      );
    } else if (isTextFile(f)) {
      body = <AttachmentTextView name={f.name} url={f.url} />;
    } else {
      body = (
        <a
          className="attachment-file-link"
          href={f.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {f.name}
        </a>
      );
    }
    tiles.push(
      <li key={`file-${f.url}`} className="attachment-tile">
        {body}
      </li>,
    );
  }

  if (tiles.length === 0) return null;
  return <ul className="attachments-grid">{tiles}</ul>;
}

function CommentItem({
  node,
  terms,
  depth,
  userNameById,
}: {
  node: CommentThreadNode;
  terms: string[];
  depth: number;
  userNameById: Map<string, string>;
}) {
  const { comment, replies } = node;
  const displayDepth = Math.min(depth, 3);
  const author = comment.author;
  const authorName = readString(author, "name") || "Anonymous";
  const avatarUrl = readString(author, "avatarURL");
  const valueRaw =
    typeof comment.value === "string" ? comment.value.trim() : "";
  const newStatus = readString(comment, "statusChangeNewStatus");
  const bodyRaw = readCommentBody(comment);
  const body = substituteCannyMentions(bodyRaw, userNameById);
  const createdLabel =
    typeof comment.created === "string"
      ? formatCreatedAt(comment.created)
      : undefined;
  const likeCount = readPositiveInt(comment.likeCount);
  const images = readImageUrls(comment.imageURLs);
  const files = readFileAttachments(comment.files);
  const hasAttachments = images.length > 0 || files.length > 0;
  const isPinned = comment.pinned === true;
  const isInternal = comment.internal === true;
  const isPrivate = comment.private === true;
  const isMerge =
    typeof comment.mergeID === "string" && comment.mergeID.trim().length > 0;
  const isStatusChangeComment =
    Boolean(newStatus) && !valueRaw && !isMerge;

  return (
    <li className="comment" data-comment-depth={displayDepth}>
      <div className="comment-header">
        <AuthorAvatar avatarUrl={avatarUrl} name={authorName} />
        <span className="comment-author">{highlightInline(authorName, terms)}</span>
        {createdLabel ? (
          <span className="comment-meta">{createdLabel}</span>
        ) : null}
        {isPinned ? <span className="comment-badge">pinned</span> : null}
        {isInternal ? <span className="comment-badge">internal</span> : null}
        {isPrivate ? <span className="comment-badge">private</span> : null}
        {isMerge ? <span className="comment-badge">merged post</span> : null}
        {likeCount !== undefined ? (
          <span className="comment-meta">
            {likeCount === 1 ? "1 like" : `${likeCount} likes`}
          </span>
        ) : null}
      </div>
      {isStatusChangeComment ||
      body ||
      hasAttachments ? (
        <div
          className={
            "hit-body" + (hasAttachments ? " has-attachments" : "")
          }
        >
          <div className="hit-body-text">
            {isStatusChangeComment ? (
              <p className="comment-status-change">
                {highlightInline(authorName, terms)} marked this post as{" "}
                <span className="hit-status">
                  {highlightInline(newStatus, terms)}
                </span>
              </p>
            ) : body ? (
              <MarkdownText source={body} highlightTerms={terms} />
            ) : null}
          </div>
          <Attachments imageUrls={images} files={files} />
        </div>
      ) : null}
      {replies.length > 0 ? (
        <ul className="comment-replies">
          {replies.map((child, idx) => (
            <CommentItem
              key={
                typeof child.comment._id === "string" && child.comment._id
                  ? child.comment._id
                  : `r-${depth}-${idx}`
              }
              node={child}
              terms={terms}
              userNameById={userNameById}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CommentsThread({
  comments,
  terms,
  userNameById,
}: {
  comments: CommentLike[];
  terms: string[];
  userNameById: Map<string, string>;
}) {
  if (comments.length === 0) {
    return null;
  }
  const roots = buildCommentThreadTree(comments);
  return (
    <section className="comments-thread">
      <h3 className="comments-heading">{formatCommentLabel(comments.length)}</h3>
      <ul className="comments-list">
        {roots.map((node, idx) => (
          <CommentItem
            key={
              typeof node.comment._id === "string" && node.comment._id
                ? node.comment._id
                : `c-${idx}`
            }
            node={node}
            terms={terms}
            userNameById={userNameById}
            depth={0}
          />
        ))}
      </ul>
    </section>
  );
}

function readAiCategories(hit: Record<string, unknown>): string[] {
  const raw = hit.aiCategories;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

function AiCategoryRefinement() {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  return (
    <>
      <input
        type="search"
        className="ai-category-search"
        placeholder="Filter AI categories…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Filter AI categories"
      />
      <RefinementList
        attribute="aiCategories"
        showMore={false}
        limit={200}
        transformItems={(items: RefinementListItem[]) => {
          const mapped = items.map((it) => ({
            ...it,
            label: aiCategoryName(it.value),
          }));
          if (!needle) return mapped;
          return mapped.filter(
            (it) =>
              it.label.toLowerCase().includes(needle) ||
              it.value.toLowerCase().includes(needle),
          );
        }}
      />
    </>
  );
}

function readHitVoteCount(hit: Record<string, unknown>): number | undefined {
  const raw = hit.score;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

function FeedbackHit({ hit }: { hit: Record<string, unknown> }) {
  const terms = useQueryTerms();
  const userNameById = useMemo(() => buildCannyUserNameMap(hit), [hit]);
  const urlName = typeof hit.urlName === "string" ? hit.urlName : undefined;
  const boardSlug = readBoardSlug(hit);
  const boardName = readBoardName(hit);
  const authorName = readPostAuthorName(hit);
  const authorAvatarUrl = readPostAuthorAvatarUrl(hit);
  const postUrl = cannyPostUrl(boardSlug, urlName);
  const createdLabel = formatCreatedAt(hit.created);
  const status = typeof hit.status === "string" ? hit.status.trim() : "";
  const voteCount = readHitVoteCount(hit);
  const detailsRaw = typeof hit.details === "string" ? hit.details : "";
  const details = substituteCannyMentions(detailsRaw, userNameById);
  const postImages = readImageUrls(hit.imageURLs);
  const postFiles = readFileAttachments(hit.files);
  const hasAttachments = postImages.length > 0 || postFiles.length > 0;
  const visibleComments = readVisibleComments(hit.comments);
  const aiCategories = readAiCategories(hit);
  const boardLabel = boardName || boardSlug;
  const statsParts: ReactNode[] = [];
  if (boardLabel) statsParts.push(<span key="board">{boardLabel}</span>);
  if (authorName)
    statsParts.push(
      <span key="author" className="hit-author">
        By
        <AuthorAvatar avatarUrl={authorAvatarUrl} name={authorName} />
        {highlightInline(authorName, terms)}
      </span>,
    );
  if (status)
    statsParts.push(
      <span key="status" className="hit-status">
        {status}
      </span>,
    );
  if (voteCount !== undefined)
    statsParts.push(
      <span key="votes" className="hit-votes">
        {voteCount === 1 ? "1 vote" : `${voteCount} votes`}
      </span>,
    );
  if (createdLabel) statsParts.push(<span key="created">Created {createdLabel}</span>);

  return (
    <article className="hit-card">
      <header className="hit-title-row">
        <span className="hit-title">
          {postUrl ? (
            <a
              className="hit-title-link"
              href={postUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Highlight attribute="title" hit={hit} />
            </a>
          ) : (
            <Highlight attribute="title" hit={hit} />
          )}
        </span>
      </header>
      {statsParts.length > 0 ? (
        <p className="hit-stats">
          {statsParts.map((part, idx) => (
            <Fragment key={idx}>
              {idx > 0 ? " · " : null}
              {part}
            </Fragment>
          ))}
        </p>
      ) : null}
      {aiCategories.length > 0 ? (
        <ul className="ai-category-list" aria-label="AI categories">
          {aiCategories.map((cid) => (
            <li
              key={cid}
              className="ai-category-chip"
              title={aiCategoryDescription(cid) ?? cid}
            >
              {aiCategoryName(cid)}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        className={
          "hit-body" + (hasAttachments ? " has-attachments" : "")
        }
      >
        <div className="hit-body-text">
          <MarkdownText source={details} highlightTerms={terms} />
        </div>
        <Attachments imageUrls={postImages} files={postFiles} />
      </div>
      <CommentsThread comments={visibleComments} terms={terms} userNameById={userNameById} />
    </article>
  );
}

export function App() {
  const [luceneMode, setLuceneMode] = useState(readStoredLuceneMode);
  const [attrPanelDismissed, setAttrPanelDismissed] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(LUCENE_MODE_STORAGE_KEY, luceneMode ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [luceneMode]);

  const searchClient = useMemo(
    () =>
      createFeedbackSearchClient(
        luceneMode ? "/api/search?mode=lucene" : "/api/search",
      ),
    [luceneMode],
  );

  return (
    <InstantSearch
      key={luceneMode ? "lucene" : "normal"}
      searchClient={searchClient}
      indexName={indexName}
      stalledSearchDelay={0}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <Configure hitsPerPage={50} maxValuesPerFacet={200} />
      <main className="layout">
        <header className="top">
          <h1>
            <a
              className="site-title-link"
              href={CANNY_ORIGIN}
              target="_blank"
              rel="noreferrer"
            >
              VRChat feedback search
            </a>
          </h1>
          <p className="lede">
            Search VRChat feedback posts.{" "}
            <a href="/openapi.json" target="_blank" rel="noreferrer">
              OpenAPI spec
            </a>
            .
          </p>
        </header>

        <div className="panels">
          <aside className="facets">
            <div className="search-row">
              <SearchBox
                placeholder={
                  luceneMode
                    ? "Lucene query (field:value, ranges, booleans)…"
                    : "Search title or body…"
                }
                searchAsYouType
                classNames={{
                  root: "searchbox-root",
                  form: "searchbox-form",
                  input: "searchbox-input",
                  submit: "searchbox-submit",
                  reset: "searchbox-reset",
                  loadingIndicator: "searchbox-loading",
                }}
              />
              <label className="lucene-toggle">
                <input
                  type="checkbox"
                  role="switch"
                  checked={luceneMode}
                  onChange={(e) => setLuceneMode(e.target.checked)}
                />
                <span className="lucene-toggle-label">Lucene syntax</span>
              </label>
              <SortBy
                classNames={{ root: "sort-root", select: "sort-select" }}
                items={[
                  { label: "Newest", value: indexName },
                  { label: "Oldest", value: `${indexName}_created_asc` },
                  { label: "Most voters", value: `${indexName}_score_desc` },
                  { label: "Fewest voters", value: `${indexName}_score_asc` },
                  { label: "Relevance", value: `${indexName}_relevance_desc` },
                ]}
              />
            </div>
            <div className="stats-toolbar">
              <p className="stats-line">
                <Stats />
              </p>
            </div>
            {luceneMode ? <LuceneSearchError /> : null}
            {luceneMode && !attrPanelDismissed ? (
              <LuceneAttributesPanel
                onClose={() => setAttrPanelDismissed(true)}
              />
            ) : null}
            {luceneMode ? null : (
              <>
                <CurrentRefinements
                  classNames={{
                    root: "current-refinements-root",
                    list: "current-refinements-list",
                    item: "current-refinements-item",
                    label: "current-refinements-label",
                    category: "current-refinements-category",
                    categoryLabel: "current-refinements-category-label",
                    delete: "current-refinements-delete",
                  }}
                />
                <ClearRefinements
                  classNames={{
                    root: "clear-refinements-root",
                    button: "clear-refinements-button",
                    disabledButton: "clear-refinements-button-disabled",
                  }}
                  translations={{ resetButtonText: "Clear all filters" }}
                />
              </>
            )}
            {luceneMode ? null : (
              <>
              <section className="facet-section">
                <h2 className="facet-heading">Board</h2>
                <RefinementList
                  attribute="board_name"
                  searchable
                  searchablePlaceholder="Filter boards…"
                  showMore
                  limit={20}
                  showMoreLimit={500}
                />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Status</h2>
                <RefinementList attribute="status" limit={50} />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Category</h2>
                <RefinementList
                  attribute="category_name"
                  searchable
                  searchablePlaceholder="Filter categories…"
                  showMore
                  limit={10}
                  showMoreLimit={200}
                />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">AI category</h2>
                <AiCategoryRefinement />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Author</h2>
                <RefinementList
                  attribute="author_name"
                  searchable
                  searchablePlaceholder="Filter authors…"
                  showMore
                  limit={10}
                  showMoreLimit={500}
                />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Post dates</h2>
                <p className="facet-hint">
                  Local date/time; range uses epoch milliseconds in the index. Clear removes the bound on that side.
                </p>
                <h3 className="facet-subheading">Created</h3>
                <EpochMsRangeInput attribute="post_created" />
                <h3 className="facet-subheading">Updated</h3>
                <EpochMsRangeInput attribute="post_updated" />
                <h3 className="facet-subheading">Status changed</h3>
                <EpochMsRangeInput attribute="post_statusChanged" />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Votes</h2>
                <RangeInput attribute="score" />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Max votes</h2>
                <RangeInput attribute="maxScore" />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Comment count</h2>
                <RangeInput attribute="commentCount" />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Merge count</h2>
                <RangeInput attribute="mergeCount" />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Trending</h2>
                <RangeInput attribute="trendingScore" />
              </section>
              <section className="facet-section facet-toggle-group">
                <h2 className="facet-heading">Vote settings</h2>
                <ToggleRefinement
                  attribute="vote_highEngagement"
                  on="true"
                  label="High engagement votes"
                />
                <ToggleRefinement
                  attribute="vote_moderateEngagement"
                  on="true"
                  label="Moderate engagement votes"
                />
                <ToggleRefinement
                  attribute="vote_lowEngagement"
                  on="true"
                  label="Low engagement votes"
                />
              </section>
              <section className="facet-section">
                <h2 className="facet-heading">Comments</h2>
                <p className="facet-hint">
                  Posts with at least one comment matching the selected criteria.
                </p>
                <h3 className="facet-subheading">Comment author</h3>
                <RefinementList
                  attribute="comment_author_name"
                  searchable
                  searchablePlaceholder="Filter comment authors…"
                  showMore
                  limit={10}
                  showMoreLimit={500}
                />
                <h3 className="facet-subheading">Comment like count</h3>
                <RangeInput attribute="comment_likeCount" />
                <h3 className="facet-subheading">Comment created</h3>
                <EpochMsRangeInput attribute="comment_created" />
                <ToggleRefinement
                  attribute="comment_pinned"
                  on="true"
                  label="Has pinned comment"
                />
              </section>
              </>
            )}
          </aside>
          <section className="results">
            <Hits
              hitComponent={FeedbackHit}
              classNames={{
                root: "hit-list-root",
                list: "hit-list",
                item: "hit-list-item",
              }}
            />
            <Pagination
              padding={2}
              classNames={{
                root: "pagination-root",
                list: "pagination-list",
                item: "pagination-item",
                link: "pagination-link",
                selectedItem: "pagination-selected",
              }}
            />
          </section>
        </div>
      </main>
    </InstantSearch>
  );
}
