import { describe, expect, it } from "vitest";
import {
  buildDelegationDescription,
  buildMetricSummary,
  buildResponsibilityRollup,
  buildStatusSentence,
  buildWorkSummary,
  computeAttainment,
  formatMetricValue,
  healthFromAttainment,
  missingForActive,
  type ResponsibilityMetricInput,
  type ResponsibilityWorkInput,
} from "../services/responsibilities.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const DAY = 86_400_000;

function metric(overrides: Partial<ResponsibilityMetricInput> = {}): ResponsibilityMetricInput {
  return {
    name: "Investors contacted",
    unit: null,
    target: 20,
    current: 12,
    direction: "at_least",
    updatedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

const noWork = (): ResponsibilityWorkInput => ({
  projects: [], blockedTasks: [], openByAssignee: [], completedRecently: 0, routines: [],
});
const noCounts = { totalTasks: 0, openTasks: 0, blockedTasks: 0, agentTasks: 0, userTasks: 0, doneTasks: 0 };

describe("responsibility attainment and status", () => {
  it("derives at_least attainment as current / target", () => {
    expect(computeAttainment("at_least", 20, 20)).toBe(1);
    expect(computeAttainment("at_least", 20, 30)).toBe(1.5);
    expect(computeAttainment("at_least", 20, 15)).toBe(0.75);
    expect(computeAttainment("at_least", 3, 1)).toBe(0.3333);
    // A negative reading against a positive target floors at 0.
    expect(computeAttainment("at_least", 20, -4)).toBe(0);
  });

  it("derives at_most attainment as target / current", () => {
    expect(computeAttainment("at_most", 2, 2)).toBe(1);
    expect(computeAttainment("at_most", 2, 1)).toBe(2);
    expect(computeAttainment("at_most", 2, 3)).toBe(0.6667);
    expect(computeAttainment("at_most", 3, 4)).toBe(0.75);
  });

  it("falls back to pass/fail when a ratio is meaningless", () => {
    // at_most with a zero or negative reading is under any positive target.
    expect(computeAttainment("at_most", 5, 0)).toBe(1);
    expect(computeAttainment("at_most", 5, -1)).toBe(1);
    // A zero target: "at most 0 incidents".
    expect(computeAttainment("at_most", 0, 0)).toBe(1);
    expect(computeAttainment("at_most", 0, 2)).toBe(0);
    // A zero or negative at_least target: "net cash flow at least 0".
    expect(computeAttainment("at_least", 0, 0)).toBe(1);
    expect(computeAttainment("at_least", 0, -5)).toBe(0);
    expect(computeAttainment("at_least", -10, -5)).toBe(1);
    expect(computeAttainment("at_least", -10, -12)).toBe(0);
  });

  it("returns null without a target or reading", () => {
    expect(computeAttainment("at_least", null, 3)).toBeNull();
    expect(computeAttainment("at_most", 3, null)).toBeNull();
  });

  it("maps attainment to on_track, at_risk, behind and not_measured at the thresholds", () => {
    expect(healthFromAttainment(1)).toBe("on_track");
    expect(healthFromAttainment(1.4)).toBe("on_track");
    expect(healthFromAttainment(0.9999)).toBe("at_risk");
    expect(healthFromAttainment(0.75)).toBe("at_risk");
    expect(healthFromAttainment(0.7499)).toBe("behind");
    expect(healthFromAttainment(0)).toBe("behind");
    expect(healthFromAttainment(null)).toBe("not_measured");
  });

  it("reports not_measured without a metric name even when numbers exist", () => {
    const rollup = buildResponsibilityRollup({
      responsibilityId: "r1", metric: metric({ name: null }), healthOverride: null, counts: noCounts, work: noWork(), now: NOW,
    });
    expect(rollup).toMatchObject({ health: "not_measured", metric: null, statusSentence: "Not measured: no metric is set" });
  });

  it("lets an override win while computedHealth keeps the metric's status", () => {
    const rollup = buildResponsibilityRollup({
      responsibilityId: "r1", metric: metric({ current: 5 }), healthOverride: "at_risk", counts: noCounts, work: noWork(), now: NOW,
    });
    expect(rollup).toMatchObject({ health: "at_risk", computedHealth: "behind", healthOverridden: true });
  });

  it("does not let work change the status", () => {
    const work = noWork();
    work.blockedTasks.push({ id: "t1", title: "Legal review" });
    work.projects.push({ id: "p1", name: "Deck", status: "in_progress", targetDate: "2026-11-01", daysUntil: -12, archived: false });
    const rollup = buildResponsibilityRollup({
      responsibilityId: "r1", metric: metric({ current: 20 }), healthOverride: null, counts: { ...noCounts, blockedTasks: 1 }, work, now: NOW,
    });
    expect(rollup.health).toBe("on_track");
    expect(rollup.workSummary.map((signal) => signal.kind)).toEqual(["project_late", "task_blocked"]);
    expect(rollup.overdueProjects).toEqual([{ id: "p1", name: "Deck", targetDate: "2026-11-01", daysOverdue: 12 }]);
  });

  it("lists what an active responsibility is missing", () => {
    expect(missingForActive({ standard: " ", metricName: null, metricTarget: null })).toEqual(["standard", "metricName", "metricTarget"]);
    expect(missingForActive({ standard: "Bar", metricName: "Reply time", metricTarget: 0 })).toEqual([]);
  });
});

describe("responsibility status sentence", () => {
  const sentence = (overrides: Partial<ResponsibilityMetricInput>) => buildStatusSentence(buildMetricSummary(metric(overrides), NOW));

  it("formats values with symbol and word units", () => {
    expect(formatMetricValue(1200, "$")).toBe("$1,200");
    expect(formatMetricValue(-50, "$")).toBe("-$50");
    expect(formatMetricValue(42.5, "%")).toBe("42.5%");
    expect(formatMetricValue(3, "days")).toBe("3 days");
    expect(formatMetricValue(3, "days", false)).toBe("3");
    expect(formatMetricValue(1 / 3, null)).toBe("0.33");
  });

  it("reads at_least as current of target with the share of target", () => {
    expect(sentence({})).toBe("12 of 20 investors contacted, 60% of target");
    expect(sentence({ unit: "investors" })).toBe("12 of 20 investors contacted, 60% of target");
    expect(sentence({ name: "Runway", unit: "months", target: 18, current: 12 })).toBe("12 of 18 months runway, 67% of target");
    expect(sentence({ name: "Monthly revenue", unit: "$", target: 20_000, current: 12_000 }))
      .toBe("$12,000 of $20,000 monthly revenue, 60% of target");
    expect(sentence({ name: "NPS", target: 50, current: 42 })).toBe("42 of 50 NPS, 84% of target");
    expect(sentence({ name: "Updates sent on time", unit: "%", target: 100, current: 90 }))
      .toBe("Updates sent on time: 90% against a target of at least 100%");
    expect(sentence({ name: "Net cash flow", target: 0, current: -5 })).toBe("-5 of 0 net cash flow, below target");
    expect(sentence({ name: "Net cash flow", target: 0, current: 3 })).toBe("3 of 0 net cash flow, target met");
  });

  it("reads at_most as the reading against an upper target", () => {
    expect(sentence({ name: "Reply time", unit: "days", target: 2, current: 3, direction: "at_most" }))
      .toBe("Reply time: 3 days against a target of at most 2 days");
    expect(sentence({ name: "Open bugs", unit: "bugs", target: 5, current: 12, direction: "at_most" }))
      .toBe("Open bugs: 12 against a target of at most 5");
  });

  it("says plainly when it is not measured", () => {
    expect(buildStatusSentence(null)).toBe("Not measured: no metric is set");
    expect(sentence({ target: null })).toBe("Not measured: investors contacted has no target");
    expect(sentence({ current: null })).toBe("Not measured yet: no reading of investors contacted against a target of 20");
    expect(sentence({ name: "Reply time", unit: "days", target: 2, current: null, direction: "at_most" }))
      .toBe("Not measured yet: no reading of reply time against a target of at most 2 days");
  });

  it("marks a reading stale after the stale window", () => {
    expect(buildMetricSummary(metric({ updatedAt: new Date(NOW.getTime() - 14 * DAY) }), NOW)?.stale).toBe(false);
    expect(buildMetricSummary(metric({ updatedAt: new Date(NOW.getTime() - 15 * DAY) }), NOW)?.stale).toBe(true);
    expect(buildMetricSummary(metric({ current: null, updatedAt: new Date(NOW.getTime() - 40 * DAY) }), NOW)?.stale).toBe(false);
  });
});

describe("responsibility work summary", () => {
  it("orders signals by tone and kind with their wording", () => {
    const work: ResponsibilityWorkInput = {
      projects: [
        { id: "late", name: "Pitch deck", status: "in_progress", targetDate: "2026-11-01", daysUntil: -12, archived: false },
        { id: "late1", name: "Data room", status: "planned", targetDate: "2026-11-12", daysUntil: -1, archived: false },
        { id: "today", name: "Board pack", status: "planned", targetDate: "2026-11-13", daysUntil: 0, archived: false },
        { id: "tomorrow", name: "LP letter", status: "planned", targetDate: "2026-11-14", daysUntil: 1, archived: false },
        { id: "soon", name: "Offsite", status: "planned", targetDate: "2026-11-18", daysUntil: 5, archived: false },
        { id: "later", name: "Annual plan", status: "planned", targetDate: "2026-12-30", daysUntil: 47, archived: false },
        { id: "done", name: "Old deck", status: "completed", targetDate: "2026-10-01", daysUntil: -43, archived: false },
      ],
      blockedTasks: [{ id: "t1", title: "Legal review" }],
      openByAssignee: [
        { agentId: "a1", userId: null, name: "Analyst", count: 1 },
        { agentId: "a2", userId: null, name: "Associate", count: 3 },
        { agentId: null, userId: "u1", name: "Dana", count: 2 },
        { agentId: null, userId: null, name: null, count: 1 },
      ],
      completedRecently: 4,
      routines: [
        { id: "r-ok", title: "Weekly pipeline review", status: "active", lastRunStatus: "completed", lastRunAt: new Date("2026-11-10T09:00:00Z"), nextRunAt: new Date("2026-11-17T09:00:00Z") },
        { id: "r-new", title: "Daily standup prep", status: "active", lastRunStatus: null, lastRunAt: null, nextRunAt: null },
        { id: "r-fail", title: "Investor CRM sync", status: "active", lastRunStatus: "failed", lastRunAt: new Date("2026-11-12T09:00:00Z"), nextRunAt: null },
        { id: "r-paused", title: "Monthly update", status: "paused", lastRunStatus: "failed", lastRunAt: null, nextRunAt: null },
        { id: "r-archived", title: "Old routine", status: "archived", lastRunStatus: null, lastRunAt: null, nextRunAt: null },
      ],
    };
    const signals = buildWorkSummary({
      responsibilityId: "resp-1",
      metric: buildMetricSummary(metric({ updatedAt: new Date(NOW.getTime() - 20 * DAY) }), NOW),
      work,
      now: NOW,
    });
    expect(signals.map(({ kind, tone, text, refType, refId, count }) => [kind, tone, text, refType, refId, count])).toEqual([
      ["metric_stale", "attention", "Investors contacted was last updated 20 days ago", "responsibility", "resp-1", 1],
      ["project_late", "attention", "Pitch deck is 12 days past its target date", "project", "late", 1],
      ["project_late", "attention", "Data room is 1 day past its target date", "project", "late1", 1],
      ["routine_failed", "attention", "Investor CRM sync failed on its last run (2026-11-12)", "routine", "r-fail", 1],
      ["task_blocked", "attention", "Legal review is blocked", "issue", "t1", 1],
      ["project_due_soon", "neutral", "Board pack is due today", "project", "today", 1],
      ["project_due_soon", "neutral", "LP letter is due tomorrow", "project", "tomorrow", 1],
      ["project_due_soon", "neutral", "Offsite is due in 5 days", "project", "soon", 1],
      ["routine_paused", "neutral", "Monthly update is paused", "routine", "r-paused", 1],
      ["tasks_open_agent", "neutral", "3 open tasks with Associate", "agent", "a2", 3],
      ["tasks_open_agent", "neutral", "1 open task with Analyst", "agent", "a1", 1],
      ["tasks_open_person", "neutral", "2 open tasks with Dana", "user", "u1", 2],
      ["tasks_open_unassigned", "neutral", "1 open task not assigned to anyone", null, null, 1],
      ["tasks_completed_recently", "good", "4 tasks completed in the last 7 days", null, null, 4],
      ["routine_active", "good", "Daily standup prep is active", "routine", "r-new", 1],
      ["routine_active", "good", "Weekly pipeline review is active, last run completed on 2026-11-10, next run 2026-11-17", "routine", "r-ok", 1],
    ]);
  });

  it("collapses a long per-item kind into a more line", () => {
    const work = noWork();
    for (let index = 1; index <= 8; index += 1) work.blockedTasks.push({ id: `t${index}`, title: `Task ${index}` });
    const signals = buildWorkSummary({ responsibilityId: "r", metric: null, work, now: NOW });
    expect(signals).toHaveLength(6);
    expect(signals.at(-1)).toEqual({ kind: "task_blocked", tone: "attention", text: "3 more tasks are blocked", refType: null, refId: null, count: 3 });
  });
});

describe("responsibility delegation text", () => {
  it("opens a delegated task with the mode instruction, then the responsibility, then the user's words", () => {
    const text = buildDelegationDescription({
      mode: "prepare_i_decide",
      responsibility: { id: "r1", title: "LP relations", standard: "Every LP hears from us monthly" },
      instructions: "Draft the Q3 letter.",
    });
    expect(text.startsWith("**How to work:** Prepare this and let me decide.")).toBe(true);
    expect(text.indexOf("LP relations")).toBeLessThan(text.indexOf("Draft the Q3 letter."));
    expect(text).toContain("Every LP hears from us monthly");
    const owned = buildDelegationDescription({
      mode: "own_from_now_on",
      responsibility: { id: "r1", title: "x", standard: null, metricName: "LPs updated" },
    });
    expect(owned).toContain("/api/responsibilities/r1/links");
    expect(owned).toContain('{ "metricCurrent": <number> }');
  });
});
