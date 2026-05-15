import Client from "@searchkit/instantsearch-client";
import {
  Configure,
  Highlight,
  Hits,
  InstantSearch,
  Pagination,
  RefinementList,
  SearchBox,
  SortBy,
  Stats,
} from "react-instantsearch";

const searchClient = Client({
  url: "/api/search",
});

const indexName = "feedback-posts";

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

function parseCommentCount(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  return undefined;
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

function readPostAuthorName(hit: Record<string, unknown>): string {
  return readString(hit.author, "name");
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
  value?: string;
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
  visible.sort((a, b) => {
    const ta = typeof a.created === "string" ? Date.parse(a.created) : NaN;
    const tb = typeof b.created === "string" ? Date.parse(b.created) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return ta - tb;
  });
  return visible;
}

function readCommentBody(c: CommentLike): string {
  return typeof c.value === "string" && c.value.trim() ? c.value : "";
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

function CommentItem({ comment }: { comment: CommentLike }) {
  const author = comment.author;
  const authorName = readString(author, "name") || "Anonymous";
  const avatarUrl = readString(author, "avatarURL");
  const body = readCommentBody(comment);
  const createdLabel =
    typeof comment.created === "string"
      ? formatCreatedAt(comment.created)
      : undefined;
  const likeCount = readPositiveInt(comment.likeCount);
  const images = readImageUrls(comment.imageURLs);
  const files = readFileAttachments(comment.files);
  const isPinned = comment.pinned === true;
  const isInternal = comment.internal === true;
  const isPrivate = comment.private === true;

  return (
    <li className="comment">
      <div className="comment-header">
        {avatarUrl ? (
          <img
            className="comment-avatar"
            src={avatarUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span className="comment-avatar comment-avatar-placeholder" aria-hidden="true">
            {authorName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="comment-author">{authorName}</span>
        {createdLabel ? (
          <span className="comment-meta">{createdLabel}</span>
        ) : null}
        {isPinned ? <span className="comment-badge">pinned</span> : null}
        {isInternal ? <span className="comment-badge">internal</span> : null}
        {isPrivate ? <span className="comment-badge">private</span> : null}
        {likeCount !== undefined ? (
          <span className="comment-meta">
            {likeCount === 1 ? "1 like" : `${likeCount} likes`}
          </span>
        ) : null}
      </div>
      {body ? <div className="comment-body">{body}</div> : null}
      {images.length > 0 ? (
        <div className="comment-attachments comment-images">
          {images.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="comment-image-link"
            >
              <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />
            </a>
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <ul className="comment-attachments comment-files">
          {files.map((f) => (
            <li key={f.url}>
              <a href={f.url} target="_blank" rel="noreferrer">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function CommentsThread({ comments }: { comments: CommentLike[] }) {
  if (comments.length === 0) {
    return null;
  }
  return (
    <section className="comments-thread">
      <h3 className="comments-heading">{formatCommentLabel(comments.length)}</h3>
      <ul className="comments-list">
        {comments.map((c, idx) => (
          <CommentItem
            key={typeof c._id === "string" && c._id ? c._id : `c-${idx}`}
            comment={c}
          />
        ))}
      </ul>
    </section>
  );
}

function FeedbackHit({ hit }: { hit: Record<string, unknown> }) {
  const urlName = typeof hit.urlName === "string" ? hit.urlName : undefined;
  const boardSlug = readBoardSlug(hit);
  const boardName = readBoardName(hit);
  const authorName = readPostAuthorName(hit);
  const postUrl = cannyPostUrl(boardSlug, urlName);
  const commentCount = parseCommentCount(hit.commentCount);
  const createdLabel = formatCreatedAt(hit.created);
  const status = typeof hit.status === "string" ? hit.status.trim() : "";
  const visibleComments = readVisibleComments(hit.comments);
  const showStats =
    Boolean(authorName) ||
    commentCount !== undefined ||
    Boolean(createdLabel) ||
    Boolean(status);

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
        {urlName && boardSlug ? (
          <span className="hit-meta-muted">
            {boardName || boardSlug} · <code className="hit-code">{urlName}</code>
          </span>
        ) : null}
      </header>
      {showStats ? (
        <p className="hit-stats">
          {authorName ? (
            <>
              By <Highlight attribute="author.name" hit={hit} />
            </>
          ) : null}
          {authorName && (commentCount !== undefined || createdLabel || status)
            ? " · "
            : null}
          {status ? <span className="hit-status">{status}</span> : null}
          {status && (commentCount !== undefined || createdLabel) ? " · " : null}
          {commentCount !== undefined ? formatCommentLabel(commentCount) : null}
          {commentCount !== undefined && createdLabel ? " · " : null}
          {createdLabel ? `Created ${createdLabel}` : null}
        </p>
      ) : null}
      <p className="hit-snippet">
        <Highlight attribute="details" hit={hit} />
      </p>
      <CommentsThread comments={visibleComments} />
    </article>
  );
}

export function App() {
  return (
    <InstantSearch
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
            Search VRChat feedback posts. Optionally filter by board or status below.
          </p>
        </header>

        <div className="search-row">
          <SearchBox
            placeholder="Search title or body…"
            searchAsYouType
            classNames={{
              root: "searchbox-root",
              form: "searchbox-form",
              input: "searchbox-input",
              submit: "searchbox-submit",
            }}
          />
        </div>
        <div className="stats-toolbar">
          <p className="stats-line">
            <Stats />
          </p>
          <SortBy
            classNames={{ root: "sort-root", select: "sort-select" }}
            items={[
              { label: "Relevance", value: indexName },
              { label: "Newest", value: `${indexName}_created_desc` },
              { label: "Highest score", value: `${indexName}_score_desc` },
            ]}
          />
        </div>

        <div className="panels">
          <aside className="facets">
            <RefinementList
              attribute="board.name"
              showMore
              limit={100}
              showMoreLimit={500}
            />
            <RefinementList attribute="status" limit={50} />
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
