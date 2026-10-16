# Status analytics

Choose **Analytics** above the results. Search, Lucene syntax, facets, ranges,
voter filters, and comment filters select the same tickets as **Posts**. Sorting
and pagination do not change the cohort. The chart selection follows filter
changes, browser back/forward, and the existing index refresh.

Historical charts describe the history of tickets matching **today's** filter.
For example, `status:tracked` selects tickets currently Tracked and displays
their earlier states too. Post/comment date filters select tickets; they do not
restrict the event dates shown. Current board/category membership is used, not
historical membership. Deleted or unavailable tickets are absent, so these are
reconstructions of the surviving cohort, not historical board censuses.

## Metrics

- **Current statuses:** one snapshot state per matching ticket.
- **Tracked age:** elapsed days since the current Tracked interval began,
  using `statusChanged` or the latest unbroken public Tracked event sequence.
  Missing start dates stay Unknown. Buckets use 30-day months and 365-day years.
- **Tracked to Completed:** elapsed days from the first recorded Tracked state
  to the first subsequent `complete` state. Includes intervening statuses and
  tickets later reopened. Mean, interpolated median, and 90th percentile describe
  eligible completed tickets only. This is not a prediction for unresolved tickets.
- **Population history:** month-end state in UTC, with the final month measured
  at the report's `asOf`. Each dated ticket enters at creation. Before the first
  reliable status record its state is Unknown; Open is never assumed.
- **Recorded changes:** public status-change records entering each status, by
  UTC month. Consecutive identical states and duplicate IDs are counted once.
  A ticket may change multiple times; a separate unique-ticket count is supplied.
  Snapshot-only dates and synthetic merge records are excluded.
- **Status duration:** accumulated ticket-days across all recorded intervals,
  including repeated visits and ongoing intervals. Unknown time is separate.
  The sum of known and unknown days equals elapsed age for dated tickets.
- **Tracked-year outcomes:** tickets grouped by first recorded Tracked year,
  split by current status. Completed share is currently Completed / all tickets
  in that cohort. Missing Tracked dates are excluded and counted. Recent cohorts
  have had less time to complete; first recorded does not mean first-ever.

Public comment timestamps are the historical event dates available in the
archive. The current snapshot's `statusChanged` supplies its latest entry date.
Private, internal, spam, deleted, and merge rows are excluded. Conflicting events
and missing labels produce unknown periods. Invalid dates are counted. Tickets
without valid creation dates remain in current totals but are excluded from
population history and accumulated durations. Invisible or unrecorded changes
cannot be recovered; coverage counts describe available evidence, not guaranteed
completeness of Canny's original history.

Every monthly chart has a data table. CSV export includes the displayed metrics
and snapshot timestamp. Empty cohorts and unavailable durations do not become zero
completion times.

## API and operations

`POST /api/analytics` accepts `{ "params": { ... } }` with filter-defining
InstantSearch params: `query`, `facetFilters`, `numericFilters`, `filters`, and
`tagFilters`. Use `?mode=lucene` when the current search uses Lucene syntax.
See `/openapi.json` for the full contract.

The gateway shares the Posts query compiler and its phrase/clause recovery.
It pins each scan to a single backing index and scrolls all matching tickets,
retrieving only identity/title/URL, current status, dates, and public-history
metadata. It does not fetch author names, voters, comment text, or attachments.
Scroll contexts are cleared on success and failure. Incomplete or timed-out
scans fail instead of returning misleading partial totals.

Results are cached for up to two minutes by filter, mode, and index generation;
identical concurrent requests share the scan. At most two scans run concurrently,
with a 60-second scan deadline and a 100,000-ticket per-filter limit. Narrow the
filter if that limit is exceeded. Cached `asOf` remains visible in the UI.

No mapping change, data migration, or archive rewrite is required. The normal
runtime sync runs `bootstrap_security.sh` to add read-only backing-index access
and cluster scroll/clear permissions to the gateway identity. It does not grant
write privileges. These permissions are required by the
[OpenSearch scroll API](https://docs.opensearch.org/latest/api-reference/search-apis/scroll/).

Run `npm test` and `npm run build` in `search-ui/`. The analytics tests cover
history reconstruction, repeated/reopened statuses, unknown periods, public-row
visibility, deduplication, UTC boundaries, paging, cleanup, caching, and parity
with real OpenSearch search filters. Integration tests require `OPENSEARCH_URL`
(default `http://127.0.0.1:9200`), as do the existing ranking/fuzz/performance tests.
