/** Public status history only. Unknown periods are retained, never filled with an assumed Open state. */
export const DAY = 86_400_000;
export type HistoryPost = {
  post_id?: string; title?: string; urlName?: string; board?: { urlName?: string };
  status?: string; created?: string; statusChanged?: string;
  comments?: Array<{
    _id?: string; statusChangeID?: string; statusChangeNewStatus?: string; created?: string;
    deleted?: boolean; spam?: boolean; private?: boolean; internal?: boolean; mergeID?: string;
  }>;
};
export type StatusEvent = { at: number; status: string; recorded: boolean };
export type StatusCount = { status: string; count: number };
export type MonthCounts = { month: string; counts: Record<string, number>; tickets?: number };
export type AnalyticsReport = {
  asOf: string; index: string; total: number;
  current: StatusCount[];
  coverage: { withEvents: number; unknownHistory: number; unknownCurrentAge: number; invalidEvents: number; undatedTickets: number };
  trackedAge: Array<{ label: string; count: number }>;
  completion: { count: number; meanDays: number | null; medianDays: number | null; p90Days: number | null; buckets: Array<{ label: string; count: number }> };
  population: MonthCounts[]; transitions: MonthCounts[];
  dwell: Array<{ status: string; days: number; tickets: number }>;
  cohorts: Array<{ year: number; total: number; counts: Record<string, number> }>;
  oldestTracked: Array<{ id: string; title: string; url: string; since: string; days: number }>;
};

function statusName(value: unknown): string {
  const name = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "unknown";
  // Older public status events used this label for Tracked.
  return name === "tracked bug" ? "tracked" : name;
}
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) ? time : null;
}

export function normalizeHistory(post: HistoryPost, asOf: number) {
  const created = timestamp(post.created);
  const current = statusName(post.status);
  let invalid = 0;
  const byId = new Map<string, StatusEvent>();
  for (const comment of Array.isArray(post.comments) ? post.comments : []) {
    if (!comment || comment.deleted || comment.spam || comment.private || comment.internal || comment.mergeID) continue;
    if (!comment.statusChangeID && !comment.statusChangeNewStatus) continue;
    const at = timestamp(comment.created);
    if (at === null || at > asOf || (created !== null && at < created)) { invalid++; continue; }
    const status = statusName(comment.statusChangeNewStatus);
    if (status === "unknown") invalid++;
    const id = comment.statusChangeID || comment._id || `${at}:${status}`;
    const old = byId.get(id);
    if (old && (old.at !== at || old.status !== status)) {
      invalid++;
      byId.set(id, { at: Math.min(old.at, at), status: "unknown", recorded: false });
    } else if (!old) byId.set(id, { at, status, recorded: true });
  }
  const raw = [...byId.values()].sort((a, b) => a.at - b.at || a.status.localeCompare(b.status));
  const events: StatusEvent[] = [];
  for (const event of raw) {
    const previous = events[events.length - 1];
    if (previous?.at === event.at) {
      if (previous.status !== event.status) { previous.status = "unknown"; previous.recorded = false; invalid++; }
    } else events.push({ ...event });
  }
  const recorded = events.filter((event) => event.recorded && event.status !== "unknown").map((event) => ({ ...event }));
  const sequence = events.map((event) => ({ ...event }));
  const since = timestamp(post.statusChanged);
  const validSince = since !== null && since <= asOf && created !== null && since >= created;
  let currentSince: number | null = null;
  const last = events[events.length - 1];
  if (validSince && (!last || since >= last.at - 5000)) {
    currentSince = since;
    if (!last || last.status !== current || Math.abs(since - last.at) > 5000) {
      // A later snapshot date in the same status implies missing intermediate history.
      if (last?.status === current && since > last.at + 5000) {
        events.push({ at: last.at, status: "unknown", recorded: false });
      }
      events.push({ at: since, status: current, recorded: false });
    }
  } else if (last?.status === current && since === null) {
    let start = events.length - 1;
    while (start > 0 && events[start - 1]!.status === current) start--;
    currentSince = events[start]!.at;
  } else if (last && last.status !== current) {
    if (last.status !== "unknown") invalid++;
    events.push({ at: last.at, status: "unknown", recorded: false });
  }
  events.sort((a, b) => a.at - b.at); // Stable: a gap marker follows the conflicting record.
  const evidence = events.filter((event) => event.status !== "unknown");
  const firstTracked = evidence.find((event) => event.status === "tracked")?.at ?? null;
  const firstComplete = firstTracked === null ? null : evidence.find((event) => event.at >= firstTracked && event.status === "complete")?.at ?? null;
  // The current snapshot is known now even if its start date is unavailable.
  events.push({ at: asOf, status: current, recorded: false });
  return { created, current, events, firstTracked, firstComplete, currentSince, invalid, recorded, sequence };
}

const AGE = [30, 90, 180, 365, 730, 1095, 1825, Infinity];
const AGE_LABELS = ["Under 1 month", "1–3 months", "3–6 months", "6–12 months", "1–2 years", "2–3 years", "3–5 years", "5+ years"];
const increment = (counts: Record<string, number>, key: string, amount = 1) => {
  const previous = Object.hasOwn(counts, key) ? counts[key]! : 0;
  Object.defineProperty(counts, key, { value: previous + amount, writable: true, enumerable: true, configurable: true });
};
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const position = (values.length - 1) * p;
  const lower = Math.floor(position);
  return values[lower]! + (values[Math.ceil(position)]! - values[lower]!) * (position - lower);
}

export function buildAnalytics(posts: Iterable<HistoryPost>, asOf: number, index: string): AnalyticsReport {
  const report: AnalyticsReport = {
    asOf: new Date(asOf).toISOString(), index, total: 0, current: [],
    coverage: { withEvents: 0, unknownHistory: 0, unknownCurrentAge: 0, invalidEvents: 0, undatedTickets: 0 },
    trackedAge: [...AGE_LABELS, "Unknown"].map((label) => ({ label, count: 0 })),
    completion: { count: 0, meanDays: null, medianDays: null, p90Days: null, buckets: AGE_LABELS.map((label) => ({ label, count: 0 })) },
    population: [], transitions: [], dwell: [], cohorts: [], oldestTracked: [],
  };
  const histories: ReturnType<typeof normalizeHistory>[] = [];
  const current: Record<string, number> = {};
  const dwell = new Map<string, { days: number; tickets: number }>();
  const cohorts = new Map<number, { total: number; counts: Record<string, number> }>();
  const transitions = new Map<string, Record<string, number>>();
  const changedTickets = new Map<string, Set<number>>();
  const completed: number[] = [];
  let earliest = asOf;
  for (const post of posts) {
    const history = normalizeHistory(post, asOf);
    histories.push(history);
    report.total++;
    increment(current, history.current);
    if (history.recorded.length) report.coverage.withEvents++;
    report.coverage.invalidEvents += history.invalid;
    if (history.created !== null && history.created <= asOf) earliest = Math.min(earliest, history.created);
    for (const event of history.recorded) earliest = Math.min(earliest, event.at);
    const ticketDays = new Map<string, number>();
    if (history.created !== null && history.created <= asOf) {
      let cursor = history.created;
      let status = "unknown";
      for (const event of history.events) {
        const end = Math.min(asOf, Math.max(cursor, event.at));
        ticketDays.set(status, (ticketDays.get(status) ?? 0) + (end - cursor) / DAY);
        cursor = end;
        status = event.status;
      }
      if ((ticketDays.get("unknown") ?? 0) > 0) report.coverage.unknownHistory++;
      for (const [status, days] of ticketDays) {
        if (days <= 0) continue;
        const row = dwell.get(status) ?? { days: 0, tickets: 0 };
        row.days += days; row.tickets++; dwell.set(status, row);
      }
    } else { report.coverage.unknownHistory++; report.coverage.undatedTickets++; }
    if (history.current === "tracked") {
      if (history.currentSince === null) { report.trackedAge[AGE.length]!.count++; report.coverage.unknownCurrentAge++; }
      else {
        const days = (asOf - history.currentSince) / DAY;
        report.trackedAge[AGE.findIndex((bound) => days < bound)]!.count++;
        report.oldestTracked.push({ id: post.post_id ?? "", title: post.title || "Untitled post", url: `https://feedback.vrchat.com/${encodeURIComponent(post.board?.urlName ?? "")}/p/${encodeURIComponent(post.urlName ?? "")}`, since: new Date(history.currentSince).toISOString(), days });
      }
    }
    if (history.firstTracked !== null) {
      const year = new Date(history.firstTracked).getUTCFullYear();
      const cohort = cohorts.get(year) ?? { total: 0, counts: {} };
      cohort.total++; increment(cohort.counts, history.current); cohorts.set(year, cohort);
      if (history.firstComplete !== null) completed.push((history.firstComplete - history.firstTracked) / DAY);
    }
    let previous: string | null = null;
    for (const event of history.sequence) {
      if (!event.recorded || event.status === "unknown") { previous = null; continue; }
      if (previous !== event.status) {
        const month = new Date(event.at).toISOString().slice(0, 7);
        const counts = transitions.get(month) ?? {};
        increment(counts, event.status); transitions.set(month, counts);
        const tickets = changedTickets.get(month) ?? new Set<number>();
        tickets.add(report.total); changedTickets.set(month, tickets);
      }
      previous = event.status;
    }
  }
  completed.sort((a, b) => a - b);
  report.completion.count = completed.length;
  report.completion.meanDays = completed.length ? completed.reduce((a, b) => a + b, 0) / completed.length : null;
  report.completion.medianDays = percentile(completed, 0.5);
  report.completion.p90Days = percentile(completed, 0.9);
  for (const days of completed) report.completion.buckets[AGE.findIndex((bound) => days < bound)]!.count++;
  report.current = Object.entries(current).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  report.dwell = [...dwell].map(([status, row]) => ({ status, ...row })).sort((a, b) => b.days - a.days);
  report.cohorts = [...cohorts].sort(([a], [b]) => a - b).map(([year, row]) => ({ year, ...row }));
  report.oldestTracked.sort((a, b) => b.days - a.days || a.id.localeCompare(b.id));
  report.oldestTracked = report.oldestTracked.slice(0, 20);
  // Month-end states for today's matching cohort. Tickets enter the population at creation.
  const cursors = histories.map(() => 0);
  for (let month = Date.UTC(new Date(earliest).getUTCFullYear(), new Date(earliest).getUTCMonth(), 1); month <= asOf;) {
    const date = new Date(month);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const end = Math.min(next - 1, asOf);
    const counts: Record<string, number> = {};
    histories.forEach((history, i) => {
      if (history.created === null || history.created > end) return;
      let cursor = cursors[i]!;
      while (cursor < history.events.length && history.events[cursor]!.at <= end) cursor++;
      cursors[i] = cursor;
      increment(counts, cursor ? history.events[cursor - 1]!.status : "unknown");
    });
    const label = date.toISOString().slice(0, 7);
    report.population.push({ month: label, counts });
    report.transitions.push({ month: label, counts: transitions.get(label) ?? {}, tickets: changedTickets.get(label)?.size ?? 0 });
    month = next;
  }
  return report;
}
