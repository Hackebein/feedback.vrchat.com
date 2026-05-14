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

function FeedbackHit({ hit }: { hit: Record<string, unknown> }) {
  const urlName =
    typeof hit.url_name === "string" ? hit.url_name : undefined;
  const boardSlug =
    typeof hit.board_slug === "string" ? hit.board_slug : undefined;
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
            Search VRChat feedback posts. Narrow by board or status or change sort order.
          </p>
        </header>

        <div className="search-row">
          <SearchBox
            placeholder="Search title or body…"
            classNames={{
              root: "searchbox-root",
              form: "searchbox-form",
              input: "searchbox-input",
              submit: "searchbox-submit",
            }}
          />
          <SortBy
            classNames={{ root: "sort-root", select: "sort-select" }}
            items={[
              { label: "Relevance", value: indexName },
              { label: "Newest", value: `${indexName}_created_at_desc` },
              { label: "Highest score", value: `${indexName}_score_desc` },
            ]}
          />
        </div>
        <p className="stats-line">
          <Stats />
        </p>

        <div className="panels">
          <aside className="facets">
            <RefinementList attribute="board_name" searchable showMore />
            <RefinementList attribute="board_slug" searchable showMore />
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
