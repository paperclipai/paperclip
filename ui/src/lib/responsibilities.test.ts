import { describe, expect, it } from "vitest";
import type { ResponsibilityTaskSummary, ResponsibilityWithRollup } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import {
  areaDealFlow,
  areaFundraising,
  areaLegal,
  areaPortfolio,
  areaTeam,
  boardReportingOverridden,
  fundraisingBehind,
  fundraisingDetail,
  hiringNotMeasured,
  lpUpdatesStale,
  metricFixture,
  portfolioOnTrack,
  responsibilityFixture,
} from "../../storybook/fixtures/responsibilities";
import {
  agentIdsFromSignals,
  agentPoweredShare,
  agentsWorkingUnder,
  attentionItems,
  describeAgentWork,
  givableFromSignal,
  barDraftFrom,
  buildBarUpdate,
  buildCreateResponsibilityPayload,
  buildDelegationPayload,
  delegationPrefillForReason,
  describeMetricReading,
  describeNextDue,
  describeReadingAge,
  describeStale,
  formatMetricValue,
  groupByArea,
  joinFieldLabels,
  lastReadingActor,
  missingFieldsFromError,
  onboardingProvenance,
  otherActiveAreas,
  parseMetricNumber,
  RESPONSIBILITY_DELEGATION_MODE_OPTIONS,
  runningSignals,
  signalHref,
  sortByStatus,
  splitResponsibilityTasks,
  validateBarDraft,
  describeDraftStatusRule,
  missingBarFields,
} from "./responsibilities";

describe("buildDelegationPayload", () => {
  it.each(RESPONSIBILITY_DELEGATION_MODE_OPTIONS.map((option) => option.value))("sends the %s mode as chosen", (mode) => {
    expect(buildDelegationPayload({ title: "  Draft the update ", assigneeAgentId: "agent-1", mode })).toEqual({
      title: "Draft the update",
      assigneeAgentId: "agent-1",
      mode,
    });
  });

  it("includes instructions and a project only when given", () => {
    expect(
      buildDelegationPayload({
        title: "Chase the lead",
        instructions: "  Use the warm intro  ",
        assigneeAgentId: "agent-1",
        mode: "handle_and_tell_me",
        projectId: "project-1",
      }),
    ).toEqual({
      title: "Chase the lead",
      instructions: "Use the warm intro",
      assigneeAgentId: "agent-1",
      mode: "handle_and_tell_me",
      projectId: "project-1",
    });
    expect(
      buildDelegationPayload({ title: "x", instructions: "   ", assigneeAgentId: "a", mode: "plan_with_me", projectId: null }),
    ).toEqual({ title: "x", assigneeAgentId: "a", mode: "plan_with_me" });
  });

  it("labels every mode with a one-line consequence", () => {
    expect(RESPONSIBILITY_DELEGATION_MODE_OPTIONS.map((option) => option.title)).toEqual([
      "Plan it with me",
      "Prepare it, I decide",
      "Handle it and tell me",
    ]);
    expect(RESPONSIBILITY_DELEGATION_MODE_OPTIONS.map((option) => option.value)).not.toContain("own_from_now_on");
    for (const option of RESPONSIBILITY_DELEGATION_MODE_OPTIONS) expect(option.description.length).toBeGreaterThan(0);
  });
});

describe("agentPoweredShare", () => {
  it("reports the agent-run share of open tasks", () => {
    expect(agentPoweredShare(3, 4)).toEqual({ percent: 75, label: "3 of 4" });
    expect(agentPoweredShare(0, 0)).toEqual({ percent: 0, label: "No open tasks" });
  });
});

describe("describeNextDue", () => {
  const now = new Date(2026, 10, 11, 15, 0, 0);
  it("formats calendar dates without a time-zone shift", () => {
    expect(describeNextDue("2026-11-20", now)).toEqual({ label: "Nov 20", late: false });
    expect(describeNextDue("2026-11-11", now)).toEqual({ label: "Nov 11", late: false });
  });
  it("marks past dates late and shows the year when it differs", () => {
    expect(describeNextDue("2026-11-10", now)).toEqual({ label: "Nov 10", late: true });
    expect(describeNextDue("2027-01-05", now)).toEqual({ label: "Jan 5, 2027", late: false });
    expect(describeNextDue(null, now)).toBeNull();
  });
});

describe("splitResponsibilityTasks", () => {
  const task = (id: string, status: ResponsibilityTaskSummary["status"]) =>
    ({ id, status }) as ResponsibilityTaskSummary;
  it("puts blocked tasks first, keeps open order, and separates finished work", () => {
    const result = splitResponsibilityTasks([
      task("a", "todo"),
      task("b", "blocked"),
      task("c", "done"),
      task("d", "in_progress"),
      task("e", "cancelled"),
    ]);
    expect(result.open.map((item) => item.id)).toEqual(["b", "a", "d"]);
    expect(result.blocked).toBe(1);
    expect(result.done.map((item) => item.id)).toEqual(["c", "e"]);
  });
});

describe("onboardingProvenance", () => {
  const area = (overrides: Partial<ResponsibilityWithRollup>) =>
    ({ source: "manual", proposedByAgentId: null, confirmedAt: null, ...overrides }) as ResponsibilityWithRollup;
  it("is null when no area came from onboarding", () => {
    expect(onboardingProvenance([area({})])).toBeNull();
  });
  it("names the drafting agent and the latest confirmation", () => {
    const result = onboardingProvenance([
      area({ source: "onboarding", proposedByAgentId: "guide", confirmedAt: new Date("2026-11-10T10:00:00Z") }),
      area({ source: "onboarding", proposedByAgentId: "guide", confirmedAt: new Date("2026-11-11T10:00:00Z") }),
    ]);
    expect(result?.agentId).toBe("guide");
    expect(result?.confirmedAt?.toISOString()).toBe("2026-11-11T10:00:00.000Z");
  });
});

describe("delegationPrefillForReason", () => {
  const overdue = [{ id: "project-1", name: "Finish the pitch deck", targetDate: "2026-10-31", daysOverdue: 12 }];

  it("turns a late project into an instruction filed in that project", () => {
    expect(delegationPrefillForReason("Finish the pitch deck is 12 days past its target date", overdue)).toEqual({
      title: "Get “Finish the pitch deck” back on schedule",
      projectId: "project-1",
    });
  });

  it("passes any other reason through for the person to edit", () => {
    expect(delegationPrefillForReason("Three candidates have waited more than a week.", overdue)).toEqual({
      title: "Three candidates have waited more than a week.",
      projectId: null,
    });
  });
});

describe("formatMetricValue", () => {
  it("puts currency in front, sticks % to the number and follows with a word", () => {
    expect(formatMetricValue(12000, "$")).toBe("$12,000");
    expect(formatMetricValue(45, "%")).toBe("45%");
    expect(formatMetricValue(3, "days")).toBe("3 days");
    expect(formatMetricValue(9, null)).toBe("9");
    expect(formatMetricValue(2.456, "")).toBe("2.46");
  });
  it("shortens millions and keeps the sign before the unit", () => {
    expect(formatMetricValue(1_250_000, "$")).toBe("$1.3M");
    expect(formatMetricValue(-5, "$")).toBe("-$5");
  });
});

describe("describeMetricReading", () => {
  it("reads higher-is-better as the number of its target", () => {
    expect(describeMetricReading(metricFixture({ current: 9, attainment: 0.45 }))).toEqual({
      current: "9",
      target: "20",
      targetLabel: "of 20",
      progress: 0.45,
      summary: "9 of 20 investors contacted",
      visual: { kind: "fill", progress: 0.45 },
    });
  });
  it("reads lower-is-better against its ceiling, with units", () => {
    const reading = describeMetricReading(lpUpdatesStale.rollup.metric!);
    expect(reading.current).toBe("36 days");
    expect(reading.targetLabel).toBe("vs. at most 30 days");
    expect(reading.summary).toBe("Days since the last LP letter: 36 days, target at most 30 days");
  });
  it("says there is no reading yet, and caps progress at the target", () => {
    const empty = describeMetricReading(hiringNotMeasured.rollup.metric!);
    expect(empty.current).toBeNull();
    expect(empty.targetLabel).toBe("target 2");
    expect(empty.progress).toBeNull();
    expect(describeMetricReading(portfolioOnTrack.rollup.metric!).progress).toBe(1);
  });
});

describe("reading age and the stale flag", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  it("phrases when a reading was taken", () => {
    expect(describeReadingAge("2026-11-13T08:00:00Z", now)).toBe("today");
    expect(describeReadingAge("2026-11-12T08:00:00Z", now)).toBe("yesterday");
    expect(describeReadingAge("2026-11-03T08:00:00Z", now)).toBe("10 days ago");
    expect(describeReadingAge("2026-09-02T08:00:00Z", now)).toBe("on Sep 2");
  });
  it("names how long a stale number has gone without an update", () => {
    expect(describeStale("2026-10-25T09:00:00Z", now)).toBe("Not updated in 19 days");
  });
});

describe("groupByArea", () => {
  const areas = [areaFundraising, areaPortfolio, areaTeam, areaLegal];
  const owned = [hiringNotMeasured, fundraisingBehind, boardReportingOverridden, lpUpdatesStale, portfolioOnTrack];

  it("groups in the areas' order, keeps item order, and puts no-area items last", () => {
    const groups = groupByArea(areas, owned);
    expect(groups.map((group) => group.area?.title ?? null)).toEqual(["Fundraising", "Portfolio", "Team", null]);
    expect(groups[0]!.items.map((item) => item.id)).toEqual([fundraisingBehind.id, lpUpdatesStale.id]);
    expect(groups[3]!.items.map((item) => item.id)).toEqual([boardReportingOverridden.id]);
  });

  it("leaves out areas with nothing in them unless asked to keep one", () => {
    expect(groupByArea(areas, owned).some((group) => group.area?.id === areaLegal.id)).toBe(false);
    const kept = groupByArea(areas, owned, new Set([areaLegal.id]));
    expect(kept.find((group) => group.area?.id === areaLegal.id)?.items).toEqual([]);
  });

  it("treats an area it does not know as no area", () => {
    const orphan = responsibilityFixture({ id: "orphan", areaId: "area-gone" });
    expect(groupByArea([areaFundraising], [orphan])).toEqual([{ area: null, items: [orphan] }]);
  });

  it("lists other active areas where the person owns nothing", () => {
    const others = otherActiveAreas([...areas, areaDealFlow], owned);
    expect(others.map((area) => area.title)).toEqual(["Legal"]);
    expect(otherActiveAreas(areas, owned, new Set([areaLegal.id]))).toEqual([]);
  });
});

describe("sortByStatus", () => {
  it("puts behind first and let-go last, stable otherwise", () => {
    const letGo = responsibilityFixture({ id: "let-go", status: "let_go", rollup: { health: "behind" } });
    const sorted = sortByStatus([portfolioOnTrack, letGo, hiringNotMeasured, lpUpdatesStale, fundraisingBehind]);
    expect(sorted.map((item) => item.id)).toEqual([fundraisingBehind.id, lpUpdatesStale.id, portfolioOnTrack.id, hiringNotMeasured.id, "let-go"]);
  });
});

describe("what needs you and what runs without you", () => {
  it("lists attention signals, or the status sentence when behind or at risk without any", () => {
    expect(attentionItems(fundraisingBehind).map((item) => item.text)).toEqual([
      "Investor update deck is 3 days past its target date",
      "Get the cap table from counsel is blocked",
    ]);
    expect(attentionItems(boardReportingOverridden)).toEqual([
      { text: boardReportingOverridden.rollup.statusSentence, signal: null },
    ]);
    expect(attentionItems(portfolioOnTrack)).toEqual([]);
  });
  it("picks the signals that show agents and routines at work", () => {
    expect(runningSignals(portfolioOnTrack).map((signal) => signal.kind)).toEqual([
      "tasks_open_agent",
      "tasks_completed_recently",
      "routine_active",
    ]);
  });
  it("links each signal to what it refers to", () => {
    const [late, blocked, agent, person, routine] = fundraisingBehind.rollup.workSummary;
    expect(signalHref(late!)).toBe("/projects/project-deck");
    expect(signalHref(blocked!)).toBe("/issues/task-blocked");
    expect(signalHref(agent!)).toBe("/agents/agent-codex");
    expect(signalHref(person!)).toBeNull();
    expect(signalHref(routine!)).toBe("/routines/routine-weekly");
  });
});

describe("the bar form", () => {
  it("parses typed numbers, blank as none", () => {
    expect(parseMetricNumber(" 1,200 ")).toBe(1200);
    expect(parseMetricNumber("-2.5")).toBe(-2.5);
    expect(parseMetricNumber("")).toBeNull();
    expect(parseMetricNumber("twenty")).toBe("invalid");
  });

  it("requires the bar, what is measured and a target", () => {
    expect(validateBarDraft(barDraftFrom())).toEqual({ ok: false, missing: ["standard", "metricName", "metricTarget"], invalid: [], problems: {} });
    expect(validateBarDraft({ ...barDraftFrom(lpUpdatesStale), metricTarget: "soon", metricCurrent: "x" })).toEqual({
      ok: false,
      missing: [],
      invalid: ["metricTarget", "metricCurrent"],
      problems: {},
    });
  });

  it("round-trips an existing bar and builds the requests", () => {
    const checked = validateBarDraft(barDraftFrom(lpUpdatesStale));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value).toEqual({
      standard: "Every LP hears from us at least once a month.",
      metricName: "Days since the last LP letter",
      metricKind: "volume",
      metricDirection: "at_most",
      metricTarget: 30,
      metricUnit: "days",
      metricLow: null,
      metricHigh: null,
      metricCurrent: 36,
    });
    expect(buildBarUpdate(checked.value)).toEqual({
      standard: "Every LP hears from us at least once a month.",
      metricKind: "volume",
      metricName: "Days since the last LP letter",
      metricTarget: 30,
      metricDirection: "at_most",
      metricUnit: "days",
      metricLow: null,
      metricHigh: null,
    });
    expect(buildCreateResponsibilityPayload({ title: " LP updates ", bar: checked.value, areaId: "area-fundraising" })).toEqual({
      title: "LP updates",
      standard: "Every LP hears from us at least once a month.",
      metricKind: "volume",
      metricName: "Days since the last LP letter",
      metricTarget: 30,
      metricDirection: "at_most",
      metricUnit: "days",
      metricCurrent: 36,
      areaId: "area-fundraising",
    });
  });

  it("leaves blank optional fields out of a new responsibility", () => {
    const checked = validateBarDraft({ ...barDraftFrom(), standard: "Bar", metricName: "Calls", metricTarget: "5" });
    if (!checked.ok) throw new Error("expected a valid draft");
    expect(buildCreateResponsibilityPayload({ title: "Calls", bar: checked.value, areaId: null })).toEqual({
      title: "Calls",
      standard: "Bar",
      metricKind: "volume",
      metricName: "Calls",
      metricTarget: 5,
      metricDirection: "at_least",
    });
  });

  it("reads the missing fields from a refused activation (422)", () => {
    const refused = new ApiError("A responsibility needs its bar", 422, {
      error: "A responsibility needs its bar (standard), a metric name and a target before it can be active",
      details: { missing: ["standard", "metricTarget"] },
    });
    expect(missingFieldsFromError(refused)).toEqual(["standard", "metricTarget"]);
    expect(joinFieldLabels(missingFieldsFromError(refused))).toBe("the bar and a target");
    expect(joinFieldLabels(["standard", "metricName", "metricTarget"])).toBe("the bar, what you measure and a target");
    expect(missingFieldsFromError(new ApiError("nope", 403, { error: "Forbidden" }))).toEqual([]);
    expect(missingFieldsFromError(new Error("boom"))).toEqual([]);
  });
});

describe("lastReadingActor", () => {
  const updatedAt = "2026-11-12T08:00:00.000Z";
  it("names who reported the current reading", () => {
    expect(lastReadingActor([
      { action: "responsibility.updated", actorType: "user", actorId: "user-1", createdAt: "2026-11-12T09:00:00Z" },
      { action: "responsibility.metric_updated", actorType: "user", actorId: "user-1", createdAt: "2026-11-01T08:00:00Z" },
      { action: "responsibility.metric_updated", actorType: "agent", actorId: "agent-codex", createdAt: "2026-11-12T08:00:01Z" },
    ], updatedAt)).toEqual({ actorType: "agent", actorId: "agent-codex" });
  });
  it("says nothing when the newest entry is for an older reading", () => {
    expect(lastReadingActor([
      { action: "responsibility.metric_updated", actorType: "agent", actorId: "agent-codex", createdAt: "2026-11-01T08:00:00Z" },
    ], updatedAt)).toBeNull();
    expect(lastReadingActor([], null)).toBeNull();
  });
});

describe("handing items to agents and who is working", () => {
  it("turns a signal that names a project, task or routine into something to give", () => {
    const [late, blocked, agent, , routine] = fundraisingBehind.rollup.workSummary;
    expect(givableFromSignal(late!)).toEqual({ kind: "project", id: "project-deck", label: late!.text, currentAgentId: null });
    expect(givableFromSignal(blocked!)?.kind).toBe("task");
    expect(givableFromSignal(routine!)?.kind).toBe("routine");
    expect(givableFromSignal(agent!)).toBeNull();
    expect(givableFromSignal(lpUpdatesStale.rollup.workSummary[0]!)).toBeNull();
  });

  it("reads the agents with open tasks from the work summary", () => {
    expect(agentIdsFromSignals(fundraisingBehind.rollup)).toEqual(["agent-codex"]);
    expect(agentIdsFromSignals(lpUpdatesStale.rollup)).toEqual([]);
  });

  it("derives the agents working under a responsibility from its tasks, routines and projects", () => {
    expect(agentsWorkingUnder(fundraisingDetail)).toEqual([{ agentId: "agent-codex", tasks: 1, routines: 1, projects: 1 }]);
    expect(agentsWorkingUnder({
      tasks: [{ assigneeAgentId: "a", status: "done" }, { assigneeAgentId: "b", status: "todo" }],
      routines: [{ assigneeAgentId: "a", status: "archived" }],
      projects: [{ leadAgentId: "c", status: "completed", archivedAt: null }, { leadAgentId: "b", status: "planned", archivedAt: null }],
    })).toEqual([{ agentId: "b", tasks: 1, routines: 0, projects: 1 }]);
    expect(describeAgentWork({ tasks: 2, routines: 1, projects: 0 })).toBe("2 tasks, 1 routine");
  });
});

describe("bar templates in the UI", () => {
  it("reads every template through describeMetricReading", async () => {
    const { METRIC_OF_EACH_TEMPLATE } = await import("../../storybook/fixtures/responsibility-bars");
    expect(describeMetricReading(METRIC_OF_EACH_TEMPLATE.percentage)).toMatchObject({
      current: "82%", targetLabel: "of 95%", visual: { kind: "fill", progress: 0.8632 },
    });
    expect(describeMetricReading(METRIC_OF_EACH_TEMPLATE.yes_no)).toMatchObject({
      current: "Yes", targetLabel: "as the bar asks", summary: "Board pack sent a week before the meeting: yes", visual: { kind: "yes_no", value: true },
    });
    expect(describeMetricReading({ ...METRIC_OF_EACH_TEMPLATE.yes_no, current: 0 })).toMatchObject({ current: "No", targetLabel: "the bar is yes" });
    expect(describeMetricReading({ ...METRIC_OF_EACH_TEMPLATE.yes_no, current: null })).toMatchObject({
      current: null, summary: "Board pack sent a week before the meeting: no answer yet",
    });
    const range = describeMetricReading(METRIC_OF_EACH_TEMPLATE.range);
    expect(range).toMatchObject({ current: "26 months", target: "12–24 months", targetLabel: "range 12–24 months", summary: "Runway: 26 months, range 12–24 months" });
    // The track runs from 6 to 30 (half the width either side): low at 25%, high at 75%, the reading at 83%.
    if (range.visual.kind !== "range") throw new Error("expected a range visual");
    expect(range.visual.low).toBeCloseTo(0.25);
    expect(range.visual.high).toBeCloseTo(0.75);
    expect(range.visual.marker).toBeCloseTo(20 / 24);
    expect(describeMetricReading({ ...METRIC_OF_EACH_TEMPLATE.range, high: null }).targetLabel).toBe("no range set");
    // A row from before templates existed reads as before.
    expect(describeMetricReading(metricFixture({ current: 9, attainment: 0.45 })).visual).toEqual({ kind: "fill", progress: 0.45 });
  });

  it("validates and builds each template's bar", () => {
    const base = { ...barDraftFrom(), standard: "Bar", metricName: "Thing" };
    const yesNo = validateBarDraft({ ...base, metricKind: "yes_no", metricTarget: "5", metricCurrent: "no" });
    if (!yesNo.ok) throw new Error("expected a valid yes-or-no draft");
    expect(yesNo.value).toMatchObject({ metricKind: "yes_no", metricTarget: null, metricDirection: null, metricUnit: null, metricCurrent: false });
    expect(buildCreateResponsibilityPayload({ title: "Board", bar: yesNo.value, areaId: null })).toEqual({
      title: "Board", standard: "Bar", metricKind: "yes_no", metricName: "Thing", metricCurrent: false,
    });

    expect(validateBarDraft({ ...base, metricKind: "range", metricLow: "24", metricHigh: "12" })).toMatchObject({
      ok: false, invalid: ["metricHigh"], problems: { metricHigh: "Above the low bound" },
    });
    expect(validateBarDraft({ ...base, metricKind: "range" })).toMatchObject({ ok: false, missing: ["metricLow", "metricHigh"] });
    const range = validateBarDraft({ ...base, metricKind: "range", metricLow: "12", metricHigh: "24", metricUnit: "months", metricTarget: "9" });
    if (!range.ok) throw new Error("expected a valid range draft");
    expect(buildBarUpdate(range.value)).toEqual({
      standard: "Bar", metricKind: "range", metricName: "Thing", metricTarget: null, metricDirection: null,
      metricUnit: "months", metricLow: 12, metricHigh: 24,
    });

    expect(validateBarDraft({ ...base, metricKind: "percentage", metricTarget: "120" })).toMatchObject({
      ok: false, invalid: ["metricTarget"], problems: { metricTarget: "A share from 0 to 100" },
    });
    const share = validateBarDraft({ ...base, metricKind: "percentage", metricTarget: "90", metricUnit: "days" });
    if (!share.ok) throw new Error("expected a valid percentage draft");
    expect(share.value).toMatchObject({ metricUnit: "%", metricDirection: "at_least" });
    expect(describeDraftStatusRule({ ...base, metricKind: "percentage", metricTarget: "90" })).toBe("On track at 90% or more; at risk from 68%");
    expect(describeDraftStatusRule({ ...base, metricKind: "range", metricLow: "", metricHigh: "24" })).toBeNull();
  });

  it("drafts an existing row in its template, inferring a % row as a percentage", () => {
    expect(barDraftFrom({ metricKind: "yes_no", metricCurrent: 0, metricName: "Pack sent" })).toMatchObject({ metricKind: "yes_no", metricCurrent: "no" });
    expect(barDraftFrom({ metricUnit: "%", metricTarget: 90 })).toMatchObject({ metricKind: "percentage", metricUnit: "", metricTarget: "90" });
    expect(barDraftFrom({ metricKind: "range", metricLow: 4, metricHigh: 8 })).toMatchObject({ metricLow: "4", metricHigh: "8" });
    expect(missingBarFields({ standard: "Bar", metricName: "Weeks of stock", metricTarget: null, metricKind: "range", metricLow: 4, metricHigh: null }))
      .toEqual(["metricHigh"]);
    expect(missingBarFields({ standard: "Bar", metricName: "Pack sent", metricTarget: null, metricKind: "yes_no" })).toEqual([]);
  });
});
