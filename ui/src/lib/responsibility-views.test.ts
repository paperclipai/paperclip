// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allOnTrackOverviewFixture,
  boardReportingOverridden,
  fundraisingBehind,
  fundraisingDetail,
  hiringDetail,
  hiringNotMeasured,
  homeOverviewFixture,
  lpUpdatesStale,
  metricFixture,
  nothingMeasuredOverviewFixture,
  portfolioOnTrack,
  responsibilityDetailFixture,
  responsibilityFixture,
  responsibilityOverviewFixture,
  RESPONSIBILITY_FIXTURE_NOW,
} from "../../storybook/fixtures/responsibilities";
import {
  boardAreaRows,
  capList,
  dashboardSnapshot,
  DASHBOARD_DEFAULT_VIEW,
  DASHBOARD_VIEW_OPTIONS,
  describeMetricGap,
  describeMissingMeasure,
  describeReadingValue,
  describeTargetPhrase,
  explainResponsibilityStatus,
  RESPONSIBILITY_PAGE_DEFAULT_VIEW,
  RESPONSIBILITY_PAGE_VIEW_OPTIONS,
  workBearings,
  exceptionReason,
  onTrackShare,
  outlineAreaGroups,
  overallStanding,
  readStoredView,
  responsibilityExceptions,
  responsibilityWorkCounts,
  responsibilityWorkList,
  writeStoredView,
} from "./responsibility-views";

const counts = (behind: number, atRisk: number, onTrack: number, notMeasured: number) => ({
  behind,
  at_risk: atRisk,
  on_track: onTrack,
  not_measured: notMeasured,
});

describe("overallStanding", () => {
  it("is behind when anything is behind, naming what is at risk too", () => {
    expect(overallStanding(counts(1, 3, 5, 0))).toEqual({
      health: "behind",
      sentence: "1 responsibility is behind and 3 are at risk.",
      total: 9,
    });
    expect(overallStanding(counts(2, 1, 0, 0)).sentence).toBe("2 responsibilities are behind and 1 is at risk.");
    expect(overallStanding(counts(2, 0, 4, 1)).sentence).toBe("2 responsibilities are behind.");
  });

  it("is at risk only when more are at risk than on track", () => {
    expect(overallStanding(counts(0, 3, 1, 0))).toMatchObject({ health: "at_risk", sentence: "Nothing is behind. 3 responsibilities are at risk." });
    expect(overallStanding(counts(0, 1, 1, 0))).toMatchObject({ health: "on_track", sentence: "Nothing is behind. 1 responsibility is at risk." });
    expect(overallStanding(counts(0, 1, 3, 0)).health).toBe("on_track");
  });

  it("is on track when nothing is behind or at risk", () => {
    expect(overallStanding(counts(0, 0, 4, 0))).toMatchObject({ health: "on_track", sentence: "Everything you own is on track." });
    expect(overallStanding(counts(0, 0, 4, 2)).sentence).toBe("Nothing is behind or at risk. 2 responsibilities are not measured yet.");
    expect(overallStanding(counts(0, 0, 1, 1)).sentence).toBe("Nothing is behind or at risk. 1 responsibility is not measured yet.");
  });

  it("is not measured when nothing is, and says when there is nothing at all", () => {
    expect(overallStanding(counts(0, 0, 0, 2))).toMatchObject({ health: "not_measured", sentence: "Nothing you own is measured yet." });
    expect(overallStanding(counts(0, 0, 0, 0))).toEqual({ health: "not_measured", sentence: "You do not own any responsibilities yet.", total: 0 });
  });

  it("reads the overview fixtures", () => {
    expect(overallStanding(homeOverviewFixture.totals.byHealth).sentence).toBe("1 responsibility is behind and 2 are at risk.");
    expect(overallStanding(allOnTrackOverviewFixture.totals.byHealth).sentence).toBe("Everything you own is on track.");
    expect(overallStanding(nothingMeasuredOverviewFixture.totals.byHealth).health).toBe("not_measured");
  });
});

describe("the Dashboard's derivations", () => {
  it("states the share on track as a rounded percentage", () => {
    expect(onTrackShare(2, 3)).toEqual({ percent: 67, label: "67% on track" });
    expect(onTrackShare(0, 2)?.label).toBe("0% on track");
    expect(onTrackShare(0, 0)).toBeNull();
  });

  it("groups the Outline by area, behind first, with the share on track and only active responsibilities", () => {
    const letGo = responsibilityFixture({ id: "resp-old", areaId: "area-portfolio", status: "let_go", rollup: { health: "on_track" } });
    const groups = outlineAreaGroups(homeOverviewFixture.areas, [...homeOverviewFixture.responsibilities, letGo]);
    expect(groups.map((group) => [group.area?.title ?? null, group.items.map((item) => item.id), group.ownedLabel, group.share?.label])).toEqual([
      ["Fundraising", [fundraisingBehind.id, lpUpdatesStale.id], "2 responsibilities you own", "0% on track"],
      ["Portfolio", [portfolioOnTrack.id], "1 responsibility you own", "100% on track"],
      ["Team", [hiringNotMeasured.id], "1 responsibility you own", "0% on track"],
      [null, [boardReportingOverridden.id], "1 responsibility you own", "0% on track"],
    ]);
    const kept = outlineAreaGroups(homeOverviewFixture.areas, homeOverviewFixture.responsibilities, new Set(["area-legal"]));
    expect(kept.find((group) => group.area?.id === "area-legal")).toMatchObject({ items: [], ownedLabel: "0 responsibilities you own", share: null });
  });

  it("counts the four numbers with one exception each, from the real totals", () => {
    expect(dashboardSnapshot(homeOverviewFixture)).toEqual({
      areas: { value: 3, line: "1 with something behind", alert: true },
      responsibilities: { value: 5, line: "1 behind", alert: true },
      projects: { value: 4, line: "1 late", alert: true },
      tasks: { value: 10, line: "1 blocked", alert: true },
    });
    expect(dashboardSnapshot(allOnTrackOverviewFixture)).toEqual({
      areas: { value: 2, line: "None with anything behind", alert: false },
      responsibilities: { value: 3, line: "None behind", alert: false },
      projects: { value: 2, line: "None late", alert: false },
      tasks: { value: 4, line: "None blocked", alert: false },
    });
  });

  it("lists only what needs a look, behind first, each with its first attention signal", () => {
    const { exceptions, onTrack } = responsibilityExceptions(homeOverviewFixture.areas, homeOverviewFixture.responsibilities);
    expect(exceptions.map((entry) => [entry.responsibility.id, entry.reason, entry.signal?.text ?? null])).toEqual([
      [fundraisingBehind.id, "behind", "Investor update deck is 3 days past its target date"],
      [lpUpdatesStale.id, "at_risk", "Days since the last LP letter was last updated 19 days ago"],
      [boardReportingOverridden.id, "at_risk", null],
      [hiringNotMeasured.id, "not_measured", null],
    ]);
    expect(onTrack.map((line) => [line.label, line.responsibilities.map((item) => item.id)])).toEqual([
      ["Portfolio: 1 of 1 on track", [portfolioOnTrack.id]],
    ]);
  });

  it("collapses everything on track to one line per area", () => {
    const { exceptions, onTrack } = responsibilityExceptions(allOnTrackOverviewFixture.areas, allOnTrackOverviewFixture.responsibilities);
    expect(exceptions).toEqual([]);
    expect(onTrack.map((line) => line.label)).toEqual(["Fundraising: 2 of 2 on track", "Portfolio: 1 of 1 on track"]);
  });

  it("counts an on-track number that has gone stale as an exception", () => {
    const stale = responsibilityFixture({
      ...portfolioOnTrack,
      rollup: { ...portfolioOnTrack.rollup, metric: metricFixture({ ...portfolioOnTrack.rollup.metric!, stale: true }) },
    });
    expect(exceptionReason(stale)).toBe("stale");
    const overview = responsibilityOverviewFixture([stale]);
    const { exceptions, onTrack } = responsibilityExceptions(overview.areas, overview.responsibilities);
    expect(exceptions.map((entry) => entry.reason)).toEqual(["stale"]);
    expect(onTrack).toEqual([{ areaId: "area-portfolio", label: "Portfolio: 1 of 1 on track", responsibilities: [] }]);
  });
});

describe("the responsibility page's derivations", () => {
  it("merges projects, tasks and routines, anything needing attention first, finished ones counted", () => {
    const { items, finished } = responsibilityWorkList(fundraisingDetail, RESPONSIBILITY_FIXTURE_NOW);
    expect(items.map((item) => [item.kind, item.id, item.attention, item.note])).toEqual([
      ["project", "project-deck", "Late · Nov 10", null],
      ["task", "task-blocked", "Blocked", null],
      ["project", "project-pipeline", null, "Due Dec 15"],
      ["task", "task-draft", null, null],
      ["task", "task-intro", null, null],
      ["routine", "routine-weekly", null, null],
    ]);
    expect(items.map((item) => item.href)).toEqual([
      "/projects/investor-update-deck",
      "/issues/PAP-41",
      "/projects/lead-investor-pipeline",
      "/issues/PAP-42",
      "/issues/PAP-43",
      "/routines/routine-weekly",
    ]);
    expect(finished).toBe(1);
  });

  it("puts a routine that failed first and marks a paused one", () => {
    const detail = responsibilityDetailFixture(
      responsibilityFixture({
        rollup: {
          workSummary: [
            { kind: "routine_failed", tone: "attention", text: "Weekly digest failed on its last run", refType: "routine", refId: "routine-digest", count: 1 },
            { kind: "routine_failed", tone: "attention", text: "2 more routines failed on the last run", refType: null, refId: null, count: 2 },
          ],
          routines: 2,
        },
      }),
      {
        routines: [
          { linkId: "l1", membership: "direct", id: "routine-paused", title: "Monthly close", status: "paused", assigneeAgentId: null, projectId: null, lastRun: null },
          { linkId: "l2", membership: "direct", id: "routine-digest", title: "Weekly digest", status: "active", assigneeAgentId: null, projectId: null, lastRun: null },
          { linkId: "l3", membership: "direct", id: "routine-old", title: "Old report", status: "archived", assigneeAgentId: null, projectId: null, lastRun: null },
        ],
      },
    );
    const list = responsibilityWorkList(detail, RESPONSIBILITY_FIXTURE_NOW);
    expect(list.items.map((item) => [item.id, item.attention, item.note])).toEqual([
      ["routine-digest", "Failed on its last run", null],
      ["routine-paused", null, "Paused"],
    ]);
    expect(list.finished).toBe(1);
    expect(responsibilityWorkCounts(detail).routines).toEqual({ value: 2, line: "3 failed, 1 paused", alert: true });
  });

  it("counts the work with one exception line each", () => {
    expect(responsibilityWorkCounts(fundraisingDetail)).toEqual({
      projects: { value: 2, line: "1 late", alert: true },
      tasks: { value: 4, line: "1 blocked, 2 with agents", alert: true },
      routines: { value: 1, line: "None failed or paused", alert: false },
    });
    expect(responsibilityWorkCounts(hiringDetail)).toEqual({
      projects: { value: 0, line: "None late", alert: false },
      tasks: { value: 0, line: "None blocked, none with agents", alert: false },
      routines: { value: 0, line: "None failed or paused", alert: false },
    });
  });

  it("caps a list and says how many more", () => {
    expect(capList([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2, 3], more: 1 });
    expect(capList([1], 3)).toEqual({ shown: [1], more: 0 });
  });
});

describe("remembering the view", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("reads back a stored choice and ignores anything it does not know", () => {
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS)).toBe("full");
    writeStoredView("view-test", "board");
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS)).toBe("board");
    writeStoredView("view-test", "spreadsheet");
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS)).toBe("full");
  });

  it("opens on Outline v2 and on One screen v2 when nothing usable is stored", () => {
    expect(DASHBOARD_DEFAULT_VIEW).toBe("outline_v2");
    expect(RESPONSIBILITY_PAGE_DEFAULT_VIEW).toBe("one_screen_v2");
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS, DASHBOARD_DEFAULT_VIEW)).toBe("outline_v2");
    writeStoredView("view-test", "spreadsheet");
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS, DASHBOARD_DEFAULT_VIEW)).toBe("outline_v2");
    writeStoredView("view-test", "outline");
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS, DASHBOARD_DEFAULT_VIEW)).toBe("outline");
    expect(readStoredView("page-test", RESPONSIBILITY_PAGE_VIEW_OPTIONS, RESPONSIBILITY_PAGE_DEFAULT_VIEW)).toBe("one_screen_v2");
  });

  it("falls back to the full view when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeStoredView("view-test", "board")).not.toThrow();
    expect(readStoredView("view-test", DASHBOARD_VIEW_OPTIONS)).toBe("full");
  });
});

// ---------------------------------------------------------------------------
// Board: why each responsibility has its status
// ---------------------------------------------------------------------------

describe("describeMetricGap", () => {
  const metric = (overrides: Parameters<typeof metricFixture>[0]) => metricFixture(overrides);

  it("says how far a higher-is-better number is from its target, in its own unit", () => {
    expect(describeMetricGap(metric({ current: 9, target: 20 }))).toBe("11 short of 20");
    expect(describeMetricGap(metric({ current: 4, target: 10, unit: "accounts" }))).toBe("6 accounts short of 10 accounts");
    expect(describeMetricGap(metric({ current: 12000, target: 20000, unit: "$" }))).toBe("$8,000 short of $20,000");
    expect(describeMetricGap(metric({ current: 45, target: 60, unit: "%" }))).toBe("15 points short of 60%");
    expect(describeMetricGap(metric({ current: 21, target: 20 }))).toBe("1 past the target of 20");
    expect(describeMetricGap(metric({ current: 4, target: 4 }))).toBe("Right at the target of 4");
    expect(describeMetricGap(metric({ current: 0.3, target: 0.1 + 0.2 }))).toBe("Right at the target of 0.3");
  });

  it("says how far a lower-is-better number is over or inside its limit", () => {
    expect(describeMetricGap(metric({ current: 36, target: 30, unit: "days", direction: "at_most" }))).toBe("6 days over the limit of 30 days");
    expect(describeMetricGap(metric({ current: 20, target: 24, unit: "hours", direction: "at_most" }))).toBe("4 hours inside the limit of 24 hours");
    expect(describeMetricGap(metric({ current: 30, target: 30, unit: "days", direction: "at_most" }))).toBe("Right at the limit of 30 days");
  });

  it("reads a yes-or-no bar and a range", () => {
    expect(describeMetricGap(metric({ kind: "yes_no", current: 1, target: null, unit: null, direction: null }))).toBe("Yes");
    expect(describeMetricGap(metric({ kind: "yes_no", current: 0, target: null, unit: null, direction: null }))).toBe("Not yet");
    const range = { kind: "range" as const, target: null, low: 10, high: 20, direction: null };
    expect(describeMetricGap(metric({ ...range, current: 8 }))).toBe("2 below the range 10–20");
    expect(describeMetricGap(metric({ ...range, current: 25, unit: "days" }))).toBe("5 days above the range 10–20 days");
    expect(describeMetricGap(metric({ ...range, current: 12 }))).toBe("Inside the range 10–20");
  });

  it("is null without a reading or a target", () => {
    expect(describeMetricGap(metric({ current: null }))).toBeNull();
    expect(describeMetricGap(metric({ current: 3, target: null }))).toBeNull();
  });
});

describe("the number on a card", () => {
  it("keeps the value and its unit together and phrases the bar beneath it", () => {
    const hours = metricFixture({ current: 20, target: 24, unit: "hours", direction: "at_most" });
    expect(describeReadingValue(hours)).toBe("20 hours");
    expect(describeTargetPhrase(hours)).toBe("limit 24 hours");
    expect(describeTargetPhrase(metricFixture({ current: 9, target: 20 }))).toBe("of 20");
    expect(describeTargetPhrase(metricFixture({ current: null, target: 20 }))).toBe("target 20");
    expect(describeTargetPhrase(metricFixture({ target: null }))).toBe("no target set");
    expect(describeTargetPhrase(metricFixture({ kind: "range", target: null, low: 1, high: 3 }))).toBe("range 1–3");
    expect(describeTargetPhrase(metricFixture({ kind: "range", target: null, low: 18, high: 24, unit: "months" }))).toBe("range 18–24 months");
    expect(describeTargetPhrase(metricFixture({ kind: "range", target: null, low: 10, high: 20, unit: "$" }))).toBe("range $10–$20");
    expect(describeTargetPhrase(metricFixture({ kind: "yes_no", target: null }))).toBeNull();
    expect(describeReadingValue(metricFixture({ kind: "yes_no", current: 1 }))).toBe("Yes");
    expect(describeReadingValue(metricFixture({ current: null }))).toBeNull();
  });

  it("says what is missing to measure it", () => {
    expect(describeMissingMeasure(null)).toBe("No number set: add what you measure and a target.");
    expect(describeMissingMeasure(metricFixture({ name: "Offers accepted", target: null }))).toBe("No target set for offers accepted.");
    expect(describeMissingMeasure(metricFixture({ name: "Offers accepted", target: 2 }))).toBe("No reading of offers accepted yet.");
    expect(describeMissingMeasure(metricFixture({ kind: "yes_no", target: null, current: null }))).toBe("No answer yet.");
    expect(describeMissingMeasure(metricFixture({ name: "Runway", kind: "range", target: null, low: null, high: 18 }))).toBe("No range set for runway.");
    expect(describeMissingMeasure(metricFixture({ current: 3 }))).toBeNull();
  });
});

describe("explainResponsibilityStatus", () => {
  it("behind: the gap, then what in the work holds it back, by name", () => {
    expect(explainResponsibilityStatus(fundraisingBehind)).toEqual({
      gap: "11 short of 20",
      missing: null,
      lines: [
        { kind: "project_late", role: "holding", text: "Investor update deck is 3 days past its target date" },
        { kind: "task_blocked", role: "holding", text: "Get the cap table from counsel is blocked" },
      ],
      more: 0,
    });
  });

  it("at risk: a stale reading and an unassigned task both hold it back; the rest is counted", () => {
    const why = explainResponsibilityStatus(lpUpdatesStale, 1);
    expect(why.gap).toBe("6 days over the limit of 30 days");
    expect(why.lines).toEqual([{ kind: "metric_stale", role: "holding", text: "Days since the last LP letter was last updated 19 days ago" }]);
    expect(why.more).toBe(1);
  });

  it("behind with nothing flagged: says what work there is and who has it", () => {
    const quiet = responsibilityFixture({
      rollup: {
        health: "behind",
        metric: metricFixture({ current: 2, target: 10, attainment: 0.2 }),
        workSummary: [
          { kind: "tasks_open_agent", tone: "neutral", text: "2 open tasks with Chief of staff", refType: "agent", refId: "agent-cos", count: 2 },
        ],
        openTasks: 2,
        agentTasks: 2,
      },
    });
    expect(explainResponsibilityStatus(quiet).lines).toEqual([
      { kind: "tasks_open_agent", role: "note", text: "2 open tasks with Chief of staff" },
    ]);
  });

  it("behind with nothing filed under it: that is the reason", () => {
    const empty = responsibilityFixture({ rollup: { health: "at_risk", metric: metricFixture({ current: 16, target: 20, attainment: 0.8 }) } });
    expect(explainResponsibilityStatus(empty).lines).toEqual([
      { kind: "no_work", role: "holding", text: "No work is filed under this yet." },
    ]);
  });

  it("not measured: what is missing, and that no work is filed under it", () => {
    expect(explainResponsibilityStatus(hiringNotMeasured)).toEqual({
      gap: null,
      missing: "No reading of offers accepted yet.",
      lines: [{ kind: "no_work", role: "holding", text: "No work is filed under this yet." }],
      more: 0,
    });
  });

  it("on track: how far past the target, and what keeps it there", () => {
    expect(explainResponsibilityStatus(portfolioOnTrack)).toEqual({
      gap: "1 past the target of 8",
      missing: null,
      lines: [{ kind: "tasks_completed_recently", role: "keeping", text: "5 tasks completed in the last 7 days" }],
      more: 0,
    });
  });

  it("a status set by hand leads with the owner's note", () => {
    const why = explainResponsibilityStatus(boardReportingOverridden);
    expect(why.gap).toBe("Right at the target of 4");
    expect(why.lines[0]).toEqual({
      kind: "override",
      role: "note",
      text: "You marked it at risk: The Q4 deck depends on numbers finance has not closed yet.",
    });
  });
});

describe("boardAreaRows", () => {
  it("splits each area's responsibilities into the four status columns, keeping the share on track", () => {
    const rows = boardAreaRows(homeOverviewFixture.areas, homeOverviewFixture.responsibilities);
    expect(rows.map((row) => [row.area?.id ?? null, row.ownedLabel, row.share?.label ?? null])).toEqual([
      ["area-fundraising", "2 responsibilities you own", "0% on track"],
      ["area-portfolio", "1 responsibility you own", "100% on track"],
      ["area-team", "1 responsibility you own", "0% on track"],
      [null, "1 responsibility you own", "0% on track"],
    ]);
    expect(Object.fromEntries(Object.entries(rows[0]!.byHealth).map(([health, items]) => [health, items.map((item) => item.id)]))).toEqual({
      behind: ["resp-fundraising"],
      at_risk: ["resp-lp-updates"],
      on_track: [],
      not_measured: [],
    });
  });
});

describe("workBearings", () => {
  const names = (id: string) => ({ "agent-codex": "CodexCoder" })[id];

  it("marks what holds the number back first, then what moves it, then the rest", () => {
    const marked = workBearings(fundraisingDetail, RESPONSIBILITY_FIXTURE_NOW, names);
    expect(marked.map((entry) => [entry.item.id, entry.bearing, entry.reason])).toEqual([
      ["project-deck", "holding", "3 days late (due Nov 10)"],
      ["task-blocked", "holding", "Blocked"],
      ["task-draft", "moving", "In progress with CodexCoder"],
      ["routine-weekly", "moving", "Active, last run succeeded on 2026-11-10, next run 2026-11-17"],
      ["project-pipeline", "neutral", "Not started, due Dec 15"],
      ["task-intro", "neutral", "With you"],
    ]);
  });

  it("holds back unassigned tasks, paused routines and routines no agent runs; lists recent completions last", () => {
    const quiet = { ...fundraisingBehind, rollup: { ...fundraisingBehind.rollup, workSummary: [], overdueProjects: [] } };
    const detail = responsibilityDetailFixture(quiet, {
      projects: [
        { linkId: "l1", id: "p-soon", name: "Partner meeting prep", status: "in_progress", targetDate: "2026-11-18", leadAgentId: null, archivedAt: null, progress: null },
      ],
      tasks: [
        { id: "t-nobody", identifier: "PAP-1", title: "Book the room", status: "todo", assigneeAgentId: null, assigneeUserId: null, projectId: null, membership: "direct", linkId: "l2", updatedAt: new Date("2026-11-12T08:00:00Z") },
        { id: "t-done", identifier: "PAP-2", title: "Send the teaser", status: "done", assigneeAgentId: "agent-codex", assigneeUserId: null, projectId: null, membership: "direct", linkId: "l3", updatedAt: new Date("2026-11-11T08:00:00Z") },
        { id: "t-old", identifier: "PAP-3", title: "Old work", status: "done", assigneeAgentId: null, assigneeUserId: null, projectId: null, membership: "direct", linkId: "l4", updatedAt: new Date("2026-10-01T08:00:00Z") },
        { id: "t-review", identifier: "PAP-4", title: "Check the numbers", status: "in_review", assigneeAgentId: null, assigneeUserId: "someone-else", projectId: null, membership: "direct", linkId: "l5", updatedAt: new Date("2026-11-12T08:00:00Z") },
      ],
      routines: [
        { linkId: "l6", membership: "direct", id: "r-paused", title: "Weekly digest", status: "paused", assigneeAgentId: "agent-codex", projectId: null, lastRun: null },
        { linkId: "l7", membership: "direct", id: "r-nobody", title: "Monthly close", status: "active", assigneeAgentId: null, projectId: null, lastRun: null },
        { linkId: "l8", membership: "direct", id: "r-new", title: "Daily scan", status: "active", assigneeAgentId: "agent-codex", projectId: null, lastRun: null },
      ],
    });
    const marked = workBearings(detail, RESPONSIBILITY_FIXTURE_NOW, names);
    expect(marked.map((entry) => [entry.item.id, entry.bearing, entry.reason, entry.finished])).toEqual([
      ["t-nobody", "holding", "Not assigned to anyone", false],
      ["r-paused", "holding", "Paused", false],
      ["r-nobody", "holding", "No agent runs it", false],
      ["p-soon", "moving", "Due Nov 18, in progress", false],
      ["t-review", "neutral", "In review with a person", false],
      ["r-new", "neutral", "Active", false],
      ["t-done", "moving", "Completed 2 days ago", true],
    ]);
  });

  it("has nothing to mark when nothing is filed", () => {
    expect(workBearings(hiringDetail, RESPONSIBILITY_FIXTURE_NOW)).toEqual([]);
  });
});
