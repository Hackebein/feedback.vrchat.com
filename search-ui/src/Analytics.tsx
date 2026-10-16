import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useInstantSearch } from "react-instantsearch";
import type { AnalyticsReport, MonthCounts } from "../../shared/status-analytics";
import { getCurrentSearchFilterKey, subscribeCurrentSearchParams } from "./searchFilterStore";

const number = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const days = (n: number | null) => n === null ? "—" : `${number(n)} days`;
const label = (status: string) => status === "complete" ? "Completed" : status.replace(/\b\w/g, (letter) => letter.toUpperCase());
const COLORS: Record<string, string> = { tracked: "#74b9ff", complete: "#6ed5a4", closed: "#f39aaf", open: "#b9a1f7", unknown: "#768299", "needs more information": "#f5cc79", "available in future release": "#6dd8d4", "in progress": "#ffab76" };
function color(status: string): string {
  const palette = ["#cc9be7", "#85cab3", "#d9bb86", "#9ea9e9", "#a8c878"];
  return COLORS[status] ?? palette[[...status].reduce((sum, c) => sum + c.charCodeAt(0), 0) % palette.length]!;
}

function Card({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return <section className="analytics-card"><h3>{title}</h3><p className="analytics-note">{note}</p>{children}</section>;
}

function Bars({ rows, unit = "tickets" }: { rows: Array<{ label: string; value: number; status?: string }>; unit?: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return <div className="analytics-bars">{rows.map((row) => <div className="analytics-bar-row" key={row.label}>
    <span>{row.label}</span><div className="analytics-bar-track" aria-hidden="true"><span style={{ width: `${100 * row.value / max}%`, background: color(row.status ?? "tracked") }} /></div>
    <span className="analytics-bar-value">{number(row.value)} <small>{unit}</small></span>
  </div>)}</div>;
}

function Timeline({ rows, description, unit }: { rows: MonthCounts[]; description: string; unit: string }) {
  const statuses = [...new Set(rows.flatMap((row) => Object.keys(row.counts)))].sort();
  const max = Math.max(1, ...rows.map((row) => Object.values(row.counts).reduce((a, b) => a + b, 0)));
  const width = Math.max(680, rows.length * 9);
  const plotWidth = width - 66;
  const barWidth = plotWidth / Math.max(1, rows.length);
  return <>
    <div className="analytics-chart-scroll"><svg className="analytics-timeline" viewBox={`0 0 ${width} 240`} style={{ minWidth: width }} role="img" aria-label={description}>
      {[0, 0.5, 1].map((fraction) => <g key={fraction}><line x1="52" x2={width - 8} y1={200 - fraction * 180} y2={200 - fraction * 180} stroke="#30394b" /><text x="45" y={204 - fraction * 180} textAnchor="end">{number(max * fraction)}</text></g>)}
      {rows.map((row, i) => {
        let offset = 0;
        return <g key={row.month}>{statuses.map((status) => {
          const count = row.counts[status] ?? 0;
          const height = count / max * 180;
          offset += height;
          return <rect key={status} x={52 + i * barWidth} y={200 - offset} width={Math.max(1, barWidth - 1)} height={height} fill={color(status)}><title>{row.month} · {label(status)}: {number(count)} {unit}</title></rect>;
        })}{(i % Math.max(1, Math.ceil(rows.length / 7)) === 0 || i === rows.length - 1) && <text x={52 + i * barWidth} y="222">{row.month}</text>}</g>;
      })}
    </svg></div>
    <div className="analytics-legend">{statuses.map((status) => <span key={status}><i style={{ background: color(status) }} />{label(status)}</span>)}</div>
    <details className="analytics-data"><summary>View monthly data</summary><div className="analytics-table-scroll"><table><caption>{description}</caption><thead><tr><th scope="col">Month (UTC)</th>{statuses.map((status) => <th scope="col" key={status}>{label(status)}</th>)}{unit === "changes" && <th scope="col">Unique tickets</th>}</tr></thead><tbody>{rows.map((row) => <tr key={row.month}><th scope="row">{row.month}</th>{statuses.map((status) => <td key={status}>{number(row.counts[status] ?? 0)}</td>)}{unit === "changes" && <td>{number(row.tickets ?? 0)}</td>}</tr>)}</tbody></table></div></details>
  </>;
}

function Cohorts({ rows }: { rows: AnalyticsReport["cohorts"] }) {
  const statuses = [...new Set(rows.flatMap((row) => Object.keys(row.counts)))].sort();
  return <>
    {rows.map((row) => <div className="analytics-cohort" key={row.year}><strong>{row.year}</strong><div className="analytics-cohort-stack" role="img" aria-label={`${row.year}: ${row.total} tickets; ${statuses.map((status) => `${label(status)} ${row.counts[status] ?? 0}`).join(", ")}`}>{statuses.map((status) => <span key={status} style={{ width: `${100 * (row.counts[status] ?? 0) / row.total}%`, background: color(status) }} title={`${label(status)}: ${row.counts[status] ?? 0}`} />)}</div><span>{number(row.total)} tickets</span></div>)}
    <div className="analytics-legend">{statuses.map((status) => <span key={status}><i style={{ background: color(status) }} />{label(status)}</span>)}</div>
    <div className="analytics-table-scroll"><table><caption>Current outcomes by first recorded Tracked year</caption><thead><tr><th scope="col">Year</th><th scope="col">Tickets</th><th scope="col">Completed</th><th scope="col">Closed</th><th scope="col">Other current statuses</th><th scope="col">Completed share</th></tr></thead><tbody>{rows.map((row) => <tr key={row.year}><th scope="row">{row.year}</th><td>{number(row.total)}</td><td>{number(row.counts.complete ?? 0)}</td><td>{number(row.counts.closed ?? 0)}</td><td>{number(row.total - (row.counts.complete ?? 0) - (row.counts.closed ?? 0))}</td><td>{number(100 * (row.counts.complete ?? 0) / row.total)}%</td></tr>)}</tbody></table></div>
  </>;
}

function downloadCsv(report: AnalyticsReport) {
  const rows: unknown[][] = [["metric", "period", "status_or_bucket", "count", "days", "as_of"]];
  const add = (metric: string, period: string, status: string, count: number | string, duration: number | string = "") => rows.push([metric, period, status, count, duration, report.asOf]);
  report.current.forEach((row) => add("current_status", "", row.status, row.count));
  report.trackedAge.forEach((row) => add("tracked_age", "", row.label, row.count));
  report.population.forEach((row) => Object.entries(row.counts).forEach(([status, count]) => add("month_end_population", row.month, status, count)));
  report.transitions.forEach((row) => {
    Object.entries(row.counts).forEach(([status, count]) => add("recorded_status_changes", row.month, status, count));
    add("changed_unique_tickets", row.month, "", row.tickets ?? 0);
  });
  report.dwell.forEach((row) => add("recorded_dwell", "", row.status, row.tickets, row.days));
  report.cohorts.forEach((row) => Object.entries(row.counts).forEach(([status, count]) => add("first_recorded_tracked_year", String(row.year), status, count)));
  report.completion.buckets.forEach((row) => add("first_tracked_to_completed", "", row.label, row.count));
  for (const [metric, duration] of [["mean", report.completion.meanDays], ["median", report.completion.medianDays], ["p90", report.completion.p90Days]] as const) add(`completion_${metric}`, "", "", report.completion.count, duration ?? "");
  const csv = rows.map((row) => row.map((cell) => {
    const text = String(cell);
    return `"${(/^[=+@-]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "feedback-status-analytics.csv"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Analytics({ luceneMode }: { luceneMode: boolean }) {
  const key = useSyncExternalStore(subscribeCurrentSearchParams, getCurrentSearchFilterKey);
  const { results } = useInstantSearch();
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setReport(null); setError("");
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(luceneMode ? "/api/analytics?mode=lucene" : "/api/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: JSON.parse(key) }), signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.message ?? "Analytics failed");
        if (!controller.signal.aborted) setReport(body as AnalyticsReport);
      } catch (error) {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Analytics failed");
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, luceneMode, results, refresh]);

  if (error) return <div className="analytics-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry analytics</button></div>;
  if (!report) return <div className="analytics-message" role="status">Calculating analytics for the current filter…</div>;
  const count = (status: string) => report.current.find((row) => row.status === status)?.count ?? 0;
  return <div className="analytics">
    <div className="analytics-heading"><div><h2>Ticket movement</h2><p>{number(report.total)} tickets matching your current search and filters</p></div><button type="button" onClick={() => downloadCsv(report)}>Download CSV</button></div>
    <p className="analytics-scope">All charts follow the current filter. Historical charts show the past of tickets matching <strong>now</strong>, using their current board, status, and other metadata. Post and comment date filters select tickets; they do not trim those tickets’ histories. Deleted or unavailable tickets are absent.</p>
    <div className="analytics-summary">{[["Tracked now", number(count("tracked"))], ["Completed now", number(count("complete"))], ["Closed now", number(count("closed"))], ["Median Tracked → Completed", days(report.completion.medianDays)]].map(([title, value]) => <div key={title}><span>{title}</span><strong>{value}</strong></div>)}</div>
    <p className="analytics-coverage">As of {new Date(report.asOf).toLocaleString()} · {number(report.coverage.withEvents)} tickets have public status events · {number(report.coverage.unknownHistory)} have unknown historical periods · {number(report.coverage.invalidEvents)} invalid or unresolved events. Unknown periods are shown explicitly and excluded from known status durations. {number(report.coverage.undatedTickets)} tickets have no valid creation date and are excluded from historical populations and durations.</p>
    {report.total === 0 ? <p className="analytics-message">No tickets match this filter. Change the search or filters to explore their history.</p> : <>
      <div className="analytics-grid">
        <Card title="Current statuses" note="One current status per matching ticket."><Bars rows={report.current.map((row) => ({ label: label(row.status), value: row.count, status: row.status }))} /></Card>
        <Card title="How long in Tracked?" note="Time since the latest entry into Tracked for currently Tracked tickets. A month is 30 days; a year is 365 days. Unknown starts stay separate."><Bars rows={report.trackedAge.map((row) => ({ label: row.label, value: row.count }))} /></Card>
      </div>
      <Card title="Status populations over time" note="Month-end state of the current matching cohort (UTC); the final month shows the current snapshot. Unknown means no reliable state is recorded for that period. This is a reconstruction, not a census of all tickets that existed then."><Timeline rows={report.population} description="Reconstructed month-end status populations" unit="tickets" /></Card>
      <Card title="Recorded status changes" note="Public events entering each status per month (UTC). A ticket can change more than once. Snapshot-only dates and synthetic merge rows are excluded."><Timeline rows={report.transitions} description="Recorded status changes by month" unit="changes" /></Card>
      <div className="analytics-grid">
        <Card title="Tracked → Completed" note={`Elapsed time from the first recorded Tracked date to the first subsequent Completed date. Includes intervening statuses and tickets later reopened. ${number(report.completion.count)} eligible tickets; unresolved tickets are excluded.`}>
          <dl className="analytics-stat-list"><div><dt>Mean</dt><dd>{days(report.completion.meanDays)}</dd></div><div><dt>Median</dt><dd>{days(report.completion.medianDays)}</dd></div><div><dt>90th percentile</dt><dd>{days(report.completion.p90Days)}</dd></div></dl>
          <Bars rows={report.completion.buckets.map((row) => ({ label: row.label, value: row.count, status: "complete" }))} />
        </Card>
        <Card title="Total time in each status" note="Recorded ticket-days, including ongoing intervals up to the snapshot. Separate visits to a status are added together. Unobserved time stays Unknown; it is not assigned to Open or Tracked.">
          <Bars rows={report.dwell.map((row) => ({ label: label(row.status), value: row.days, status: row.status }))} unit="days" />
          <details className="analytics-data"><summary>View duration data</summary><table><caption>Recorded time by status</caption><thead><tr><th scope="col">Status</th><th scope="col">Ticket-days</th><th scope="col">Tickets with time recorded</th></tr></thead><tbody>{report.dwell.map((row) => <tr key={row.status}><th scope="row">{label(row.status)}</th><td>{number(row.days)}</td><td>{number(row.tickets)}</td></tr>)}</tbody></table></details>
        </Card>
      </div>
      <Card title="Outcomes by Tracked year" note={`Grouped by the first recorded Tracked year, with each ticket’s current outcome. The first recorded date may be later than its first-ever tracking date. ${number(report.total - report.cohorts.reduce((sum, row) => sum + row.total, 0))} tickets have no known Tracked date and are excluded. Recent cohorts have had less time to reach Completed.`}>{report.cohorts.length ? <Cohorts rows={report.cohorts} /> : <p>No recorded Tracked dates in this selection.</p>}</Card>
      <Card title="Longest currently in Tracked" note={`${number(report.coverage.unknownCurrentAge)} currently Tracked tickets have no known start date and are excluded. Showing up to 20 tickets.`}><div className="analytics-table-scroll"><table><caption>Tickets with the longest current Tracked interval</caption><thead><tr><th scope="col">Ticket</th><th scope="col">Tracked since (UTC)</th><th scope="col">Days</th></tr></thead><tbody>{report.oldestTracked.map((row) => <tr key={row.id}><th scope="row"><a href={row.url} target="_blank" rel="noreferrer">{row.title}</a></th><td>{row.since.slice(0, 10)}</td><td>{number(row.days)}</td></tr>)}</tbody></table></div></Card>
    </>}
  </div>;
}
