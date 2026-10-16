import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildAnalytics, DAY, normalizeHistory, type HistoryPost } from "../../shared/status-analytics";

const at = (day: string) => `${day}T00:00:00.000Z`;
const now = Date.parse(at("2020-03-01"));
const event = (id: string, day: string, status: string) => ({ _id: id, statusChangeID: id, created: at(day), statusChangeNewStatus: status });
const complete: HistoryPost = {
  post_id: "complete", title: "Repeated Tracked periods", board: { urlName: "bugs" }, urlName: "repeated",
  created: at("2020-01-01"), status: "complete", statusChanged: at("2020-02-20"),
  comments: [event("4", "2020-02-20", "complete"), event("1", "2020-01-11", "tracked"), event("2", "2020-02-01", "open"), event("3", "2020-02-11", "tracked"), event("1", "2020-01-11", "tracked")],
};
const tracked: HistoryPost = { post_id: "tracked", created: at("2020-01-01"), status: "tracked", statusChanged: at("2020-01-21") };
const open: HistoryPost = { post_id: "open", created: at("2020-01-01"), status: "open", statusChanged: at("2020-01-01") };
const report = buildAnalytics([complete, tracked, open], now, "test");
assert.equal(report.total, 3);
assert.equal(report.completion.count, 1);
assert.equal(report.completion.meanDays, 40, "elapsed time includes the detour through Open");
assert.equal(report.completion.medianDays, 40);
assert.equal(report.dwell.find((row) => row.status === "tracked")?.days, 70, "separate Tracked visits are added, including ongoing time");
assert.equal(report.dwell.find((row) => row.status === "open")?.days, 70);
assert.equal(report.dwell.find((row) => row.status === "complete")?.days, 10);
assert.equal(report.dwell.find((row) => row.status === "unknown")?.days, 30, "missing initial history is never assumed Open");
assert.equal(report.dwell.reduce((sum, row) => sum + row.days, 0), 180, "known plus unknown time conserves ticket age");
assert.deepEqual(report.population[0]?.counts, { tracked: 2, open: 1 });
assert.deepEqual(report.population.at(-1)?.counts, { complete: 1, tracked: 1, open: 1 });
assert.equal(report.transitions[0]?.counts.tracked, 1, "duplicate IDs are counted once; snapshot dates are not events");
assert.equal(report.transitions[1]?.counts.tracked, 1);
assert.equal(report.transitions[1]?.tickets, 1, "three February changes affect one distinct ticket");
assert.deepEqual(report.cohorts, [{ year: 2020, total: 2, counts: { complete: 1, tracked: 1 } }]);
assert.equal(report.trackedAge[1]?.count, 1);

const reopened = { ...complete, status: "tracked", statusChanged: at("2020-02-25"), comments: [...complete.comments!, event("5", "2020-02-25", "tracked")] };
const reopenedReport = buildAnalytics([reopened], now, "test");
assert.equal(reopenedReport.oldestTracked[0]?.days, 5, "current age starts at the latest entry");
assert.equal(reopenedReport.completion.meanDays, 40, "reopening does not erase first completion");
assert.equal(reopenedReport.cohorts[0]?.counts.tracked, 1, "cohort outcomes use current status");

const hidden = ["private", "internal", "deleted", "spam"].map((flag, i) => ({ ...event(`hidden-${i}`, "2020-01-03", "closed"), [flag]: true }));
const incomplete = buildAnalytics([{ ...tracked, statusChanged: undefined, comments: [
  ...hidden, { ...event("merge", "2020-01-04", "closed"), mergeID: "merge" },
  event("before", "2019-12-01", "complete"), event("future", "2021-01-01", "complete"),
  event("tracked", "2020-01-11", "tracked"), { ...event("unresolved", "2020-02-01", ""), statusChangeNewStatus: undefined },
] }], now, "test");
assert.equal(incomplete.transitions.flatMap((row) => Object.keys(row.counts)).includes("closed"), false);
assert.equal(incomplete.dwell.find((row) => row.status === "tracked")?.days, 21, "unresolved events break the known status interval");
assert.equal(incomplete.coverage.unknownCurrentAge, 1);
assert.equal(incomplete.coverage.invalidEvents, 3);

const conflict = normalizeHistory({ ...tracked, statusChanged: undefined, comments: [event("a", "2020-01-11", "tracked"), event("b", "2020-01-11", "closed")] }, now);
assert.equal(conflict.recorded.length, 0, "conflicting events at one timestamp cannot establish a status");
assert.equal(conflict.firstTracked, null);
const noDate = buildAnalytics([{ post_id: "undated", status: "tracked" }], now, "test");
assert.equal(noDate.coverage.undatedTickets, 1);
assert.equal(noDate.coverage.unknownCurrentAge, 1);
assert.equal(noDate.population.at(-1)?.counts.tracked, undefined);
assert.equal(noDate.completion.meanDays, null);
const zero = buildAnalytics([], now, "test");
assert.equal(zero.total, 0);
assert.equal(zero.completion.p90Days, null);
assert.equal(zero.cohorts.length, 0);

const exactNow = buildAnalytics([{ ...complete, statusChanged: at("2020-03-01"), comments: [event("a", "2020-01-11", "tracked"), event("b", "2020-03-01", "complete")] }], now, "test");
assert.equal(exactNow.completion.count, 1, "events exactly at the snapshot are included");
const monthEdge = buildAnalytics([{ ...complete, created: at("2020-01-31"), comments: [event("a", "2020-02-01", "tracked"), event("b", "2020-02-20", "complete")] }], now, "test");
assert.deepEqual(monthEdge.population[0]?.counts, { unknown: 1 });
assert.equal(monthEdge.transitions[0]?.counts.tracked, undefined, "UTC month boundaries are exclusive of the next month");

const started = performance.now();
const large = buildAnalytics(Array.from({ length: 40_000 }, (_, i) => ({ ...complete, post_id: String(i) })), now, "test");
assert.equal(large.total, 40_000);
assert.equal(large.completion.count, 40_000);
console.info(`status analytics tests passed; 40,000-ticket reconstruction: ${Math.round(performance.now() - started)}ms`);
