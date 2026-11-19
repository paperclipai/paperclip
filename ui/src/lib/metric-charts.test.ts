import { describe, expect, it } from "vitest";
import {
  barRects,
  CHART_HEIGHT,
  CHART_WIDTH,
  chartDomain,
  describeMetricChart,
  describeMetricTarget,
  linePath,
  linePoints,
  metricReferences,
  proposalMetricPreview,
  ringDash,
  scaleLinear,
  yFor,
  ZERO_BAR_HEIGHT,
} from "./metric-charts";
import { meetingsBar, noReadingsLine, oneReadingLine, primaryLine, replyTimeLine } from "../../storybook/fixtures/responsibility-metrics";
import { barProposalWithMetricsFixture } from "../../storybook/fixtures/responsibility-metrics";

const at = (day: number) => new Date(Date.UTC(2026, 10, day)).toISOString();

describe("chartDomain", () => {
  it("covers every reading and the target, with room either side", () => {
    expect(chartDomain([10, 20], [30])).toEqual({ min: 8, max: 32 });
  });
  it("starts bars at zero and gives a flat series room", () => {
    expect(chartDomain([4, 6], [], { zeroBased: true })).toEqual({ min: 0, max: 6.3 });
    expect(chartDomain([5, 5], [])).toEqual({ min: 4.5, max: 5.5 });
    expect(chartDomain([0], [], { zeroBased: true })).toEqual({ min: 0, max: 1 });
    expect(chartDomain([], [])).toEqual({ min: 0, max: 1 });
  });
  it("keeps a percent between 0 and 100", () => {
    expect(chartDomain([95, 100], [90], { percent: true })).toEqual({ min: 89, max: 100 });
    expect(chartDomain([], [], { percent: true })).toEqual({ min: 0, max: 100 });
  });
});

describe("scales", () => {
  it("maps a domain onto a range, backwards for y", () => {
    expect(scaleLinear({ min: 0, max: 10 }, [0, 100])(5)).toBe(50);
    const domain = { min: 0, max: 10 };
    expect(yFor(domain, 10)).toBeLessThan(yFor(domain, 0));
    expect(yFor(domain, 0)).toBeLessThanOrEqual(CHART_HEIGHT);
  });
});

describe("linePoints and linePath", () => {
  const domain = { min: 0, max: 10 };
  it("draws nothing with no readings", () => {
    expect(linePoints([], domain)).toEqual([]);
    expect(linePath([])).toBe("");
  });
  it("puts a single reading in the middle, with no line through it", () => {
    const points = linePoints([{ value: 5, recordedAt: at(1) }], domain);
    expect(points).toHaveLength(1);
    expect(points[0]!.x).toBe(CHART_WIDTH / 2);
    expect(linePath(points)).toBe("");
  });
  it("spaces many readings by time, first to last, oldest on the left", () => {
    const points = linePoints([
      { value: 1, recordedAt: at(1) },
      { value: 5, recordedAt: at(2) },
      { value: 9, recordedAt: at(11) },
    ], domain);
    expect(points[0]!.x).toBeLessThan(points[1]!.x);
    expect(points[2]!.x).toBeGreaterThan(CHART_WIDTH - 5);
    // A tenth of the way along in time is a tenth of the way along the line.
    expect((points[1]!.x - points[0]!.x) / (points[2]!.x - points[0]!.x)).toBeCloseTo(0.1, 5);
    expect(points[2]!.y).toBeLessThan(points[0]!.y);
    expect(linePath(points)).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  });
});

describe("barRects", () => {
  it("draws one bar per reading from the baseline, and a stub for a zero", () => {
    const domain = chartDomain([0, 2, 4], [], { zeroBased: true });
    const bars = barRects([
      { value: 0, recordedAt: at(1) },
      { value: 2, recordedAt: at(8) },
      { value: 4, recordedAt: at(15) },
    ], domain);
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ zero: true, height: ZERO_BAR_HEIGHT });
    expect(bars[2]!.height).toBeCloseTo(bars[1]!.height * 2, 5);
    // Every bar sits on the same baseline.
    expect(bars[1]!.y + bars[1]!.height).toBeCloseTo(bars[2]!.y + bars[2]!.height, 5);
    expect(bars[2]!.x + bars[2]!.width).toBeLessThanOrEqual(CHART_WIDTH);
    expect(barRects([], domain)).toEqual([]);
  });
});

describe("ringDash", () => {
  it("fills the share of the ring, clamped", () => {
    expect(ringDash(0.25, 15.9155).dasharray).toBe("25 75");
    expect(ringDash(2, 15.9155).dasharray).toBe("100 0");
  });
});

describe("words", () => {
  it("names the target and the reference lines", () => {
    expect(describeMetricTarget(primaryLine)).toBe("target 20");
    expect(describeMetricTarget(replyTimeLine)).toBe("target at most 24 hours");
    expect(metricReferences(replyTimeLine)).toEqual([{ value: 24, label: "At most 24 hours" }]);
    expect(metricReferences({ ...primaryLine, kind: "range", low: 12, high: 24, unit: "months" }).map((line) => line.label)).toEqual([
      "High 24 months",
      "Low 12 months",
    ]);
    expect(metricReferences({ ...primaryLine, kind: "yes_no" })).toEqual([]);
  });

  it("gives every chart a text alternative, for none, one and many readings", () => {
    expect(describeMetricChart(noReadingsLine)).toBe("Line over time of Follow-ups sent within two days: no readings yet, target 10.");
    expect(describeMetricChart(oneReadingLine)).toBe("Line over time of Follow-ups sent within two days: 4, one reading so far, target 10.");
    expect(describeMetricChart(meetingsBar)).toMatch(/^Bars per week of Intro meetings booked per week: 8 weeks from \w+ \d+, between 0 and 5, latest 5, target 3\.$/);
  });
});

describe("proposalMetricPreview", () => {
  it("draws a proposal's set as it will appear: the bar's metric first, then the supporting ones", () => {
    const preview = proposalMetricPreview(barProposalWithMetricsFixture().payload, new Date("2026-11-13T12:00:00Z"))!;
    expect(preview.metrics.map((metric) => [metric.role, metric.title, metric.display])).toEqual([
      ["primary", "Prospective LPs contacted in the last 14 days", "line"],
      ["supporting", "Intro calls booked per week", "bar"],
      ["supporting", "LP emails answered within a day", "percent"],
    ]);
    expect(preview.metrics[1]!.readings).toHaveLength(5);
    expect(preview.keepsSupporting).toBe(false);
    expect(preview.primary.current).toBe(79);
  });
  it("is null for a proposal that leaves the set alone", () => {
    const { payload } = barProposalWithMetricsFixture();
    expect(proposalMetricPreview({ ...payload, metrics: null, primaryDisplay: null }, new Date())).toBeNull();
  });
});
