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

function FeedbackHit({ hit }: { hit: Record<string, unknown> }) {
  const urlName =
    typeof hit.url_name === "string" ? hit.url_name : undefined;
  const boardSlug =
    typeof hit.board_slug === "string" ? hit.board_slug : undefined;
  const commentCount = parseCommentCount(hit.comment_count);
  const createdLabel = formatCreatedAt(hit.created_at);
  const statsParts: string[] = [];
  if (commentCount !== undefined) {
    statsParts.push(formatCommentLabel(commentCount));
  }
  if (createdLabel) {
    statsParts.push(`Created ${createdLabel}`);
  }
  const statsLine = statsParts.length > 0 ? statsParts.join(" · ") : null;

  return (
    <article className="hit-card">
      <header className="hit-title-row">
        <span className="hit-title">
          <Highlight attribute="title" hit={hit} />
        </span>
        {urlName && boardSlug ? (
          <span className="hit-meta-muted">
            {boardSlug} · <code className="hit-code">{urlName}</code>
          </span>
        ) : null}
      </header>
      {statsLine ? <p className="hit-stats">{statsLine}</p> : null}
      <p className="hit-snippet">
        <Highlight attribute="details" hit={hit} />
      </p>
    </article>
  );
}

export function App() {
  return (
    <InstantSearch searchClient={searchClient} indexName={indexName} future={{ preserveSharedStateOnUnmount: true }}>
      <Configure hitsPerPage={15} />
      <main className="layout">
        <header className="top">
          <h1>VRChat feedback search</h1>
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
              { label: "Newest", value: `${indexName}_created_at_desc` },
              { label: "Highest score", value: `${indexName}_score_desc` },
            ]}
          />
        </div>

        <div className="panels">
          <aside className="facets">
            <RefinementList attribute="board_name" showMore />
            <RefinementList attribute="status" />
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
