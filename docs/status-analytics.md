# Status analytics

Choose **Analytics** above the results. Charts use the same search and filters as **Posts**.

- Current post counts by status
- Time spent in Tracked
- Tracked → Completed times, with mean, median, and 90th percentile
- Monthly status changes and status populations
- Total days spent in each status
- Current outcomes by first recorded Tracked year
- Links to the longest-waiting Tracked posts
- Data tables and CSV export

Historical charts show the past of posts matching the current filter. Missing history is shown as **Unknown**.

The API is `POST /api/analytics` with `{ "params": { ... } }`. Add `?mode=lucene` for Lucene searches. See `/openapi.json` for details.
