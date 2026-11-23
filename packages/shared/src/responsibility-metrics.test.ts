import { describe, expect, it } from "vitest";
import { acceptResponsibilityBarProposalSchema, createResponsibilityBarProposalSchema } from "./responsibility-bars.js";
import {
  RESPONSIBILITY_VISUALIZATION_LABEL,
  responsibilityMetricDisplaysFor,
  responsibilityVisualizationDisplay,
  responsibilityVisualizationOf,
  responsibilityVisualizationsFor,
  setResponsibilityMetricDisplaySchema,
  chooseStarterMetrics,
  defaultPrimaryDisplay,
  normalizeResponsibilityMetricDefinition,
  responsibilityMetricDefinitionSchema,
  setResponsibilityMetricsSchema,
  weeklyCounts,
  type ResponsibilityStarterFacts,
} from "./responsibility-metrics.js";

const none: ResponsibilityStarterFacts = {
  primary: null,
  finishedByWeek: [0, 0, 0, 0, 0, 0],
  openTasks: 0,
  blockedTasks: 0,
  automationShare: null,
};

describe("chooseStarterMetrics", () => {
  it("leads with the bar's metric, then starters that have something in them", () => {
    expect(chooseStarterMetrics({
      primary: { kind: "volume", readings: 5 },
      finishedByWeek: [1, 0, 2, 3, 1, 4],
      openTasks: 6,
      blockedTasks: 0,
      automationShare: 0.25,
    })).toEqual([
      { key: "bar_metric", display: "line" },
      { key: "tasks_finished", display: "bar" },
      { key: "automation_share", display: "percent" },
    ]);
  });

  it("puts blocked work ahead of everything but the bar", () => {
    expect(chooseStarterMetrics({
      primary: { kind: "percentage", readings: 0 },
      finishedByWeek: [0, 0, 0, 0, 0, 1],
      openTasks: 3,
      blockedTasks: 2,
      automationShare: 0.5,
    })).toEqual([
      { key: "bar_metric", display: "percent" },
      { key: "open_tasks", display: "number" },
      { key: "tasks_finished", display: "bar" },
    ]);
  });

  it("never shows an empty weekly chart when a better starter exists", () => {
    const choice = chooseStarterMetrics({ ...none, primary: { kind: "range", readings: 1 }, openTasks: 2 });
    expect(choice).toEqual([
      { key: "bar_metric", display: "number" },
      { key: "open_tasks", display: "number" },
    ]);
    expect(choice.some((entry) => entry.key === "tasks_finished")).toBe(false);
  });

  it("shows open tasks alone when there is nothing at all", () => {
    expect(chooseStarterMetrics(none)).toEqual([{ key: "open_tasks", display: "number" }]);
  });

  it("draws a yes or no as its answer, and never more than three", () => {
    const choice = chooseStarterMetrics({
      primary: { kind: "yes_no", readings: 9 },
      finishedByWeek: [1, 1, 1, 1, 1, 1],
      openTasks: 4,
      blockedTasks: 1,
      automationShare: 0.4,
    });
    expect(choice).toHaveLength(3);
    expect(choice[0]).toEqual({ key: "bar_metric", display: "number" });
  });
});

describe("defaultPrimaryDisplay", () => {
  it("is a line once a count has two readings", () => {
    expect(defaultPrimaryDisplay("volume", 0)).toBe("number");
    expect(defaultPrimaryDisplay("volume", 1)).toBe("number");
    expect(defaultPrimaryDisplay("volume", 2)).toBe("line");
    expect(defaultPrimaryDisplay("percentage", 8)).toBe("percent");
  });
});

describe("weeklyCounts", () => {
  const now = new Date("2026-11-16T12:00:00.000Z");
  it("counts each instant in its week, the last seven days last, and drops the rest", () => {
    const buckets = weeklyCounts([
      "2026-11-16T09:00:00.000Z",
      "2026-11-10T13:00:00.000Z",
      "2026-11-09T11:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
      "2026-11-17T00:00:00.000Z",
    ], now);
    expect(buckets.map((bucket) => bucket.count)).toEqual([0, 0, 0, 0, 1, 2]);
    expect(buckets[5]!.start.toISOString()).toBe("2026-11-09T12:00:00.000Z");
  });
});

describe("supporting metric definitions", () => {
  const base = { title: "Replies within a day", description: "Share of investor emails answered within 24 hours", display: "percent" as const };

  it("normalizes a percent's unit and sorts readings oldest first", () => {
    const parsed = responsibilityMetricDefinitionSchema.parse({
      ...base,
      target: 90,
      readings: [
        { value: 80, recordedAt: "2026-11-09T00:00:00.000Z" },
        { value: 70, recordedAt: "2026-11-02T00:00:00.000Z" },
      ],
    });
    const normalized = normalizeResponsibilityMetricDefinition(parsed);
    expect(normalized.unit).toBe("%");
    expect(normalized.direction).toBe("at_least");
    expect(normalized.readings.map((reading) => reading.value)).toEqual([70, 80]);
  });

  it("rejects a percent outside 0 to 100, a direction without a target and a future reading", () => {
    expect(responsibilityMetricDefinitionSchema.safeParse({ ...base, target: 120 }).success).toBe(false);
    expect(responsibilityMetricDefinitionSchema.safeParse({ ...base, direction: "at_most" }).success).toBe(false);
    expect(responsibilityMetricDefinitionSchema.safeParse({
      ...base,
      readings: [{ value: 10, recordedAt: new Date(Date.now() + 3_600_000).toISOString() }],
    }).success).toBe(false);
  });

  it("lets the owner set at most two", () => {
    expect(setResponsibilityMetricsSchema.safeParse({ metrics: [base, { ...base, title: "B" }] }).success).toBe(true);
    expect(setResponsibilityMetricsSchema.safeParse({ metrics: [base, { ...base, title: "B" }, { ...base, title: "C" }] }).success).toBe(false);
  });
});

describe("the bar proposal with a metric set", () => {
  const bar = {
    standard: "Every prospective LP hears from us at least every two weeks.",
    metricKind: "percentage" as const,
    metricName: "Prospective LPs contacted in the last 14 days",
    metricTarget: 90,
  };
  const supporting = { title: "Replies within a day", description: "Share of LP emails answered in 24 hours", display: "line" as const };

  it("accepts up to two supporting metrics and a primary display that fits the template", () => {
    expect(createResponsibilityBarProposalSchema.safeParse({ ...bar, primaryDisplay: "line", metrics: [supporting] }).success).toBe(true);
    expect(createResponsibilityBarProposalSchema.safeParse({ ...bar, metrics: [] }).success).toBe(true);
  });

  it("rejects a third supporting metric, a duplicate title, unexplained readings and a display the template cannot take", () => {
    const three = [supporting, { ...supporting, title: "B" }, { ...supporting, title: "C" }];
    expect(createResponsibilityBarProposalSchema.safeParse({ ...bar, metrics: three }).success).toBe(false);
    expect(createResponsibilityBarProposalSchema.safeParse({ ...bar, metrics: [{ ...supporting, title: bar.metricName }] }).success).toBe(false);
    expect(createResponsibilityBarProposalSchema.safeParse({
      ...bar,
      metrics: [{ ...supporting, readings: [{ value: 3, recordedAt: "2026-11-01T00:00:00.000Z" }] }],
    }).success).toBe(false);
    expect(createResponsibilityBarProposalSchema.safeParse({
      standard: "Board pack out a week early.",
      metricKind: "yes_no",
      metricName: "Board pack sent a week before",
      primaryDisplay: "line",
    }).success).toBe(false);
  });
});

describe("the five visualizations", () => {
  it("names every metric in a person's words", () => {
    expect(Object.values(RESPONSIBILITY_VISUALIZATION_LABEL)).toEqual(["Number", "Percent", "Yes / No", "Trend", "Per week"]);
    expect(responsibilityVisualizationOf({ display: "line" })).toBe("trend");
    expect(responsibilityVisualizationOf({ display: "bar" })).toBe("per_week");
    expect(responsibilityVisualizationOf({ display: "number", kind: "yes_no" })).toBe("yes_no");
    expect(responsibilityVisualizationDisplay("yes_no")).toBe("number");
    expect(responsibilityVisualizationDisplay("per_week")).toBe("bar");
  });

  it("offers only the forms a metric's data allows", () => {
    const forms = (metric: Parameters<typeof responsibilityVisualizationsFor>[0]) => responsibilityVisualizationsFor(metric);
    expect(forms({ role: "primary", kind: "volume", display: "line" })).toEqual(["number", "trend", "per_week"]);
    expect(forms({ role: "primary", kind: "percentage", display: "percent" })).toEqual(["number", "percent", "trend", "per_week"]);
    expect(forms({ role: "primary", kind: "yes_no", display: "number" })).toEqual(["yes_no"]);
    // A range shows as a number or a trend with its band.
    expect(forms({ role: "primary", kind: "range", display: "line" })).toEqual(["number", "trend"]);
    expect(responsibilityMetricDisplaysFor({ role: "primary", kind: "range", display: "line" })).toEqual(["number", "line"]);
    expect(forms({ role: "supporting", display: "bar", unit: null })).toEqual(["number", "trend", "per_week"]);
    expect(forms({ role: "supporting", display: "number", unit: "%" })).toEqual(["number", "percent", "trend", "per_week"]);
  });

  it("validates the narrow writes", () => {
    expect(setResponsibilityMetricDisplaySchema.safeParse({ display: "line" }).success).toBe(true);
    expect(setResponsibilityMetricDisplaySchema.safeParse({ display: "pie" }).success).toBe(false);
    expect(setResponsibilityMetricDisplaySchema.safeParse({ display: "line", title: "x" }).success).toBe(false);
    expect(acceptResponsibilityBarProposalSchema.safeParse({}).success).toBe(true);
    expect(acceptResponsibilityBarProposalSchema.safeParse({ keepMetrics: [] }).success).toBe(true);
    expect(acceptResponsibilityBarProposalSchema.safeParse({ keepMetrics: [0, 1] }).success).toBe(true);
    expect(acceptResponsibilityBarProposalSchema.safeParse({ keepMetrics: [0, 0] }).success).toBe(false);
    expect(acceptResponsibilityBarProposalSchema.safeParse({ keepMetrics: [2] }).success).toBe(false);
  });
});
