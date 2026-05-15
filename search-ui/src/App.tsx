import Client from "@searchkit/instantsearch-client";
import { Fragment, type ReactNode, useMemo } from "react";
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
  useSearchBox,
} from "react-instantsearch";
import { MarkdownText } from "./MarkdownText";
import { detectVideoEmbed } from "./videoEmbed";
import { VideoEmbedView } from "./VideoEmbedView";

const LUCENE_OPERATOR_WORDS = new Set([
  "and",
  "or",
  "not",
  "to",
]);

/**
 * Terms for client-side highlighting from a Lucene-style `query_string` in the search box.
 * Strips field prefixes, boolean/range noise, and quoted delimiters; not a full Lucene parser.
 */
function tokenizeQuery(q: string): string[] {
  if (!q.trim()) return [];

  let s = q.replace(/\s+/g, " ").trim();
  // Unwrap double-quoted phrases to surface words for highlighting
  s = s.replace(/"([^"]*)"/g, " $1 ");

  s = s.replace(
    /\b(AND|OR|NOT|TO)\b|[()[\]{}]|(?<=\s|^)[+\-](?=\s|$)/gi,
    " ",
  );

  const raw = s.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();

  for (const t of raw) {
    let x = t.replace(/^[+^]+/, "").replace(/\*+$/, "");
    if (!x) continue;

    const colon = x.indexOf(":");
    if (colon !== -1) {
      const maybeField = x.slice(0, colon);
      if (/^[\w.]+$/.test(maybeField)) {
        x = x.slice(colon + 1);
      }
    }

    if (!x || x === "*" || x === "?") continue;
    if (LUCENE_OPERATOR_WORDS.has(x.toLowerCase())) continue;

    const trimmed = x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!trimmed) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
    }
  }
  return [...seen];
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
  const raw =
    typeof c.value === "string" && c.value.trim() ? c.value.trim() : "";
  if (raw) {
    return raw;
  }
  const newStatus = readString(c, "statusChangeNewStatus");
  if (newStatus) {
    return newStatus;
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
    tiles.push(
      <li key={`img-${url}`} className="attachment-tile">
        {embed ? (
          <VideoEmbedView embed={embed} />
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="attachment-image-link"
          >
            <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </a>
        )}
      </li>,
    );
  }

  for (const f of files) {
    const embed = detectVideoEmbed(f.url);
    let body: ReactNode;
    if (embed) {
      body = <VideoEmbedView embed={embed} title={f.name} />;
    } else if (isTextFile(f)) {
      body = (
        <div className="attachment-text">
          <iframe className="attachment-text-frame" src={f.url} title={f.name} />
          <a
            className="attachment-text-link"
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {f.name}
          </a>
        </div>
      );
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
  comment,
  terms,
}: {
  comment: CommentLike;
  terms: string[];
}) {
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
  const isMerge =
    typeof comment.mergeID === "string" && comment.mergeID.trim().length > 0;

  return (
    <li className="comment">
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
      {body ? <MarkdownText source={body} highlightTerms={terms} /> : null}
      <Attachments imageUrls={images} files={files} />
    </li>
  );
}

function CommentsThread({
  comments,
  terms,
}: {
  comments: CommentLike[];
  terms: string[];
}) {
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
            terms={terms}
          />
        ))}
      </ul>
    </section>
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
  const urlName = typeof hit.urlName === "string" ? hit.urlName : undefined;
  const boardSlug = readBoardSlug(hit);
  const boardName = readBoardName(hit);
  const authorName = readPostAuthorName(hit);
  const authorAvatarUrl = readPostAuthorAvatarUrl(hit);
  const postUrl = cannyPostUrl(boardSlug, urlName);
  const createdLabel = formatCreatedAt(hit.created);
  const status = typeof hit.status === "string" ? hit.status.trim() : "";
  const voteCount = readHitVoteCount(hit);
  const details = typeof hit.details === "string" ? hit.details : "";
  const postImages = readImageUrls(hit.imageURLs);
  const postFiles = readFileAttachments(hit.files);
  const visibleComments = readVisibleComments(hit.comments);
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
      <MarkdownText source={details} highlightTerms={terms} />
      <Attachments imageUrls={postImages} files={postFiles} />
      <CommentsThread comments={visibleComments} terms={terms} />
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
            Search VRChat feedback posts (Lucene <code>query_string</code>).{" "}
            <a href="/lucene-syntax.md" target="_blank" rel="noreferrer">
              Lucene cheat sheet
            </a>
            , <a href="/openapi.json" target="_blank" rel="noreferrer">OpenAPI spec</a>.
          </p>
        </header>

        <div className="search-row">
          <SearchBox
            placeholder='Lucene query, e.g. title:crash AND status:open'
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

        <div className="panels">
          <aside className="facets">
            <ClearRefinements
              classNames={{
                root: "clear-refinements-root",
                button: "clear-refinements-button",
                disabledButton: "clear-refinements-button-disabled",
              }}
              translations={{ resetButtonText: "Clear all filters" }}
            />
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
              <ToggleRefinement
                attribute="comment_pinned"
                on="true"
                label="Has pinned comment"
              />
            </section>
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
