import { describe, expect, it } from "vitest";
import type { ResponsibilityTaskSummary } from "@paperclipai/shared";
import { ago, projectDueStat, projectProgressLabel, routineStat, runStat, splitTasksForTable } from "./responsibility-one-screen-v2";

const NOW = new Date(2026, 10, 13, 12, 0, 0);
const before = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("ago", () => {
  it("says how long ago against the page's now, in short units", () => {
    expect(ago(before(20_000), NOW)).toBe("just now");
    expect(ago(before(5 * 60_000), NOW)).toBe("5m ago");
    expect(ago(before(8 * HOUR), NOW)).toBe("8h ago");
    expect(ago(before(2 * DAY), NOW)).toBe("2d ago");
    expect(ago(before(15 * DAY), NOW)).toBe("2w ago");
    expect(ago(before(65 * DAY), NOW)).toBe("2mo ago");
    // A time just after now (clock skew) reads as now, never as negative.
    expect(ago(new Date(NOW.getTime() + 5_000), NOW)).toBe("just now");
  });
});

describe("routineStat", () => {
  it("says how its last run went and when, or that it is paused or has not run", () => {
    expect(routineStat({ status: "active", lastRun: { outcome: "succeeded", at: before(8 * HOUR) } }, NOW)).toBe("Last successful run 8h ago");
    expect(routineStat({ status: "active", lastRun: { outcome: "failed", at: before(2 * DAY) } }, NOW)).toBe("Failed 2d ago");
    expect(routineStat({ status: "active", lastRun: { outcome: "running", at: before(3 * HOUR) } }, NOW)).toBe("Running, started 3h ago");
    expect(routineStat({ status: "active", lastRun: null }, NOW)).toBe("Not run yet");
    // Paused says so, whatever its last run did.
    expect(routineStat({ status: "paused", lastRun: { outcome: "failed", at: before(DAY) } }, NOW)).toBe("Paused");
    expect(routineStat({ status: "paused", lastRun: null }, NOW)).toBe("Paused");
  });
});

describe("projectDueStat", () => {
  it("counts calendar days to its target date, and says late once it has passed", () => {
    expect(projectDueStat({ targetDate: "2026-11-27" }, NOW)).toBe("Due in 14 days");
    expect(projectDueStat({ targetDate: "2026-11-14" }, NOW)).toBe("Due tomorrow");
    expect(projectDueStat({ targetDate: "2026-11-13" }, NOW)).toBe("Due today");
    expect(projectDueStat({ targetDate: "2026-11-12" }, NOW)).toBe("1 day late");
    expect(projectDueStat({ targetDate: "2026-11-08" }, NOW)).toBe("5 days late");
    // Late in the evening is still the same calendar day.
    expect(projectDueStat({ targetDate: "2026-11-14" }, new Date(2026, 10, 13, 23, 59))).toBe("Due tomorrow");
    // Across a month and a year.
    expect(projectDueStat({ targetDate: "2027-01-02" }, new Date(2026, 11, 31, 9))).toBe("Due in 2 days");
  });

  it("says nothing without a date", () => {
    expect(projectDueStat({ targetDate: null }, NOW)).toBeNull();
    expect(projectDueStat({ targetDate: "soon" }, NOW)).toBeNull();
  });

  it("puts its progress in words for the meter", () => {
    expect(projectProgressLabel({ done: 4, total: 10 })).toBe("4 of 10 tasks done");
    expect(projectProgressLabel({ done: 0, total: 1 })).toBe("0 of 1 task done");
  });
});

describe("runStat", () => {
  const run = (status: string) => ({ status, createdAt: before(DAY).toISOString(), startedAt: before(DAY).toISOString(), finishedAt: before(2 * HOUR).toISOString() });
  it("says how a run ended and when, or that it is still going", () => {
    expect(runStat(run("succeeded"), NOW)).toBe("Succeeded 2h ago");
    expect(runStat(run("failed"), NOW)).toBe("Failed 2h ago");
    expect(runStat(run("cancelled"), NOW)).toBe("Cancelled 2h ago");
    expect(runStat(run("timed_out"), NOW)).toBe("Timed out 2h ago");
    expect(runStat({ ...run("running"), finishedAt: null }, NOW)).toBe("Running, started 1d ago");
    expect(runStat({ ...run("queued"), startedAt: null, finishedAt: null }, NOW)).toBe("Queued 1d ago");
    expect(runStat(run("some_new_status"), NOW)).toBe("Some new status 2h ago");
  });
});

describe("splitTasksForTable", () => {
  const task = (id: string, status: ResponsibilityTaskSummary["status"]): ResponsibilityTaskSummary => ({
    id, identifier: null, title: id, status, assigneeAgentId: null, assigneeUserId: null, projectId: null, membership: "direct", linkId: null, updatedAt: NOW,
  });
  it("keeps open tasks in order, and the done ones to reveal; cancelled ones are neither", () => {
    const split = splitTasksForTable([task("a", "in_progress"), task("b", "done"), task("c", "blocked"), task("d", "cancelled"), task("e", "done")]);
    expect(split.open.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(split.done.map((entry) => entry.id)).toEqual(["b", "e"]);
  });
});
