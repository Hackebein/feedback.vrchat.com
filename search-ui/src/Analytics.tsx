import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useInstantSearch } from "react-instantsearch";
import type { AnalyticsReport, MonthCounts } from "../../shared/status-analytics";
import { getCurrentSearchFilterKey, subscribeCurrentSearchParams } from "./searchFilterStore";

const number = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const days = (n: number | null) => n === null ? "—" : `${number(n)} days`;
const label = (status: string) => status === "complete" ? "Completed" : status.replace(/\b\w/g, (letter) => letter.toUpperCase());
const cohortStatus = (status: string) => status === "open" ? "reopened" : status;
const COLORS: Record<string, string> = { tracked: "#74b9ff", complete: "#6ed5a4", closed: "#f39aaf", open: "#b9a1f7", unknown: "#768299", "needs more information": "#f5cc79", "available in future release": "#6dd8d4", "in progress": "#ffab76" };
function color(status: string): string {
  const palette = ["#cc9be7", "#85cab3", "#d9bb86", "#9ea9e9", "#a8c878"];
  return COLORS[status] ?? palette[[...status].reduce((sum, c) => sum + c.charCodeAt(0), 0) % palette.length]!;
}

function Card({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return <section className="analytics-card"><header className="analytics-card-heading"><h3>{title}</h3>{note && <p className="analytics-note">{note}</p>}</header>{children}</section>;
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
    {rows.map((row) => <div className="analytics-cohort" key={row.year}><strong>{row.year}</strong><div className="analytics-cohort-stack" role="img" aria-label={`${row.year}: ${row.total} tickets; ${statuses.map((status) => `${label(cohortStatus(status))} ${row.counts[status] ?? 0}`).join(", ")}`}>{statuses.map((status) => <span key={status} style={{ width: `${100 * (row.counts[status] ?? 0) / row.total}%`, background: color(status) }} title={`${label(cohortStatus(status))}: ${row.counts[status] ?? 0}`} />)}</div><span>{number(row.total)} tickets</span></div>)}
    <div className="analytics-legend">{statuses.map((status) => <span key={status}><i style={{ background: color(status) }} />{label(cohortStatus(status))}</span>)}</div>
    <details className="analytics-data"><summary>View yearly data</summary><div className="analytics-table-scroll"><table><caption>Outcomes by first recorded Tracked year</caption><thead><tr><th scope="col">Year</th><th scope="col">Tickets</th><th scope="col">Completed</th><th scope="col">Closed</th><th scope="col">Reopened</th><th scope="col">Other</th><th scope="col">Completed share</th></tr></thead><tbody>{rows.map((row) => <tr key={row.year}><th scope="row">{row.year}</th><td>{number(row.total)}</td><td>{number(row.counts.complete ?? 0)}</td><td>{number(row.counts.closed ?? 0)}</td><td>{number(row.counts.open ?? 0)}</td><td>{number(row.total - (row.counts.complete ?? 0) - (row.counts.closed ?? 0) - (row.counts.open ?? 0))}</td><td>{number(100 * (row.counts.complete ?? 0) / row.total)}%</td></tr>)}</tbody></table></div></details>
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
  report.cohorts.forEach((row) => Object.entries(row.counts).forEach(([status, count]) => add("first_recorded_tracked_year", String(row.year), cohortStatus(status), count)));
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(luceneMode ? "/api/analytics?mode=lucene" : "/api/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ params: JSON.parse(key) }), signal: controller.signal });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body) throw new Error(body?.message ?? "Analytics unavailable; please retry");
        if (!controller.signal.aborted) { setReport(body as AnalyticsReport); setLoading(false); }
      } catch (error) {
        if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : "Analytics failed"); setLoading(false); }
      }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, luceneMode, results, refresh]);

  if (!report) return error
    ? <div className="analytics-message" role="alert"><p>{error}</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry analytics</button></div>
    : <div className="analytics-message" role="status">Loading analytics…</div>;
  return <div className="analytics" aria-busy={loading}>
    <div className="analytics-heading"><div><h2>Ticket movement</h2><p title={`Updated ${new Date(report.asOf).toLocaleString()}`}>{number(report.total)} tickets · current filters{loading && <span className="analytics-refresh" role="status"> · Updating…</span>}</p></div><button type="button" onClick={() => downloadCsv(report)}>Download CSV</button></div>
    {error && <div className="analytics-refresh-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry analytics</button></div>}
    {report.total === 0 ? <p className="analytics-message">No tickets match this filter.</p> : <>
      <div className="analytics-grid">
        <Card title="Current statuses"><Bars rows={report.current.map((row) => ({ label: label(row.status), value: row.count, status: row.status }))} /></Card>
        <Card title="How long in Tracked?" note="Time in the current Tracked period."><Bars rows={report.trackedAge.map((row) => ({ label: row.label, value: row.count }))} /></Card>
      </div>
      <Card title="Status populations over time" note="These tickets’ estimated month-end statuses. Missing history is Unknown."><Timeline rows={report.population} description="Reconstructed month-end status populations" unit="tickets" /></Card>
      <Card title="Recorded status changes" note="Public status changes each month."><Timeline rows={report.transitions} description="Recorded status changes by month" unit="changes" /></Card>
      <div className="analytics-grid">
        <Card title="Tracked → Completed" note={`First recorded Tracked to first completion · ${number(report.completion.count)} tickets.`}>
          <dl className="analytics-stat-list"><div><dt>Mean</dt><dd>{days(report.completion.meanDays)}</dd></div><div><dt>Median</dt><dd>{days(report.completion.medianDays)}</dd></div><div><dt>90th percentile</dt><dd>{days(report.completion.p90Days)}</dd></div></dl>
          <Bars rows={report.completion.buckets.map((row) => ({ label: row.label, value: row.count, status: "complete" }))} />
        </Card>
        <Card title="Total time in each status" note="Days added across tickets, including repeat visits.">
          <Bars rows={report.dwell.map((row) => ({ label: label(row.status), value: row.days, status: row.status }))} unit="days" />
          <details className="analytics-data"><summary>View duration data</summary><table><caption>Recorded time by status</caption><thead><tr><th scope="col">Status</th><th scope="col">Ticket-days</th><th scope="col">Tickets with time recorded</th></tr></thead><tbody>{report.dwell.map((row) => <tr key={row.status}><th scope="row">{label(row.status)}</th><td>{number(row.days)}</td><td>{number(row.tickets)}</td></tr>)}</tbody></table></details>
        </Card>
      </div>
      <Card title="Outcomes by Tracked year" note="Current outcomes, grouped by first recorded Tracked year.">{report.cohorts.length ? <Cohorts rows={report.cohorts} /> : <p>No recorded Tracked dates.</p>}</Card>
      <Card title="Longest currently in Tracked" note="Up to 20 tickets with a known Tracked start date."><div className="analytics-table-scroll"><table><thead><tr><th scope="col">Ticket</th><th scope="col">Tracked since (UTC)</th><th scope="col">Days</th></tr></thead><tbody>{report.oldestTracked.map((row) => <tr key={row.id}><th scope="row"><a href={row.url} target="_blank" rel="noreferrer">{row.title}</a></th><td>{row.since.slice(0, 10)}</td><td>{number(row.days)}</td></tr>)}</tbody></table></div></Card>
    </>}
  </div>;
}
