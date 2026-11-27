import {
  defaultPrimaryDisplay,
  responsibilityAttainment,
  responsibilityBarMetricFromProposal,
  responsibilityStatusRule,
  type ProposeResponsibilityBarPayload,
  type ResponsibilityMetricPoint,
  type ResponsibilityMetricSummary,
  type ResponsibilityMetricView,
} from "@paperclipai/shared";
import { formatMetricRange, formatMetricValue } from "./responsibilities";

/**
 * Geometry and words for the small charts a responsibility's metrics are
 * drawn with (line over time, bars per week, a ring for a share). Pure, so
 * the scales and the sparse cases (no readings, one, many) are tested
 * without rendering. Charts draw in a fixed viewBox (`CHART_WIDTH` ×
 * `CHART_HEIGHT`) stretched to their box; labels are HTML placed by the
 * shares these helpers return.
 */

export const CHART_WIDTH = 100;
export const CHART_HEIGHT = 40;
/** Room kept above and below the marks, in viewBox units. */
const PAD_Y = 4;
/** Room either side of a line, so its end points are not cut off. */
const PAD_X = 3;
/** The share of each bar's slot left empty between bars. */
const BAR_GAP_SHARE = 0.3;
/** A zero still draws a stub on the baseline, so the period is visibly there. */
export const ZERO_BAR_HEIGHT = 1;

export interface Domain {
  min: number;
  max: number;
}

/**
 * The value range a chart shows: every reading and the reference lines
 * (target, or a range's bounds), with a little room. Bars and counts start
 * at zero. A flat series gets room around its one value. A percent stays
 * within 0 to 100.
 */
export function chartDomain(
  values: readonly number[],
  references: readonly number[],
  opts: { zeroBased?: boolean; percent?: boolean } = {},
): Domain {
  const all = [...values, ...references].filter((value) => Number.isFinite(value));
  if (all.length === 0) return opts.percent ? { min: 0, max: 100 } : { min: 0, max: 1 };
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (opts.zeroBased) min = Math.min(0, min);
  if (max === min) {
    const room = max === 0 ? 1 : Math.abs(max) * 0.1;
    min = opts.zeroBased ? Math.min(0, min) : min - room;
    max += room;
  } else if (!opts.zeroBased) {
    const room = (max - min) * 0.1;
    min -= room;
    max += room;
  } else {
    max += (max - min) * 0.05;
  }
  if (opts.percent) {
    min = Math.max(0, min);
    max = Math.min(100, max);
    if (max <= min) max = Math.min(100, min + 1);
  }
  return { min, max };
}

/** A linear scale from `domain` onto `range` (which may run backwards, as y does). */
export function scaleLinear(domain: Domain, range: [number, number]) {
  const span = domain.max - domain.min || 1;
  return (value: number) => range[0] + ((value - domain.min) / span) * (range[1] - range[0]);
}

/** Y in viewBox units (0 at the top) for a value. */
export function yFor(domain: Domain, value: number) {
  return scaleLinear(domain, [CHART_HEIGHT - PAD_Y, PAD_Y])(value);
}

export interface LinePoint {
  x: number;
  y: number;
  value: number;
  recordedAt: string;
}

/**
 * Where each reading sits on a line over time: x by time between the first
 * and last reading, y by value. One reading sits in the middle; none, nothing.
 */
export function linePoints(readings: readonly Pick<ResponsibilityMetricPoint, "value" | "recordedAt">[], domain: Domain): LinePoint[] {
  if (readings.length === 0) return [];
  const times = readings.map((reading) => new Date(reading.recordedAt).getTime());
  const first = Math.min(...times);
  const last = Math.max(...times);
  const x = last === first
    ? () => CHART_WIDTH / 2
    : scaleLinear({ min: first, max: last }, [PAD_X, CHART_WIDTH - PAD_X]);
  return readings.map((reading, index) => ({
    x: readings.length === 1 ? CHART_WIDTH / 2 : x(times[index]!),
    y: yFor(domain, reading.value),
    value: reading.value,
    recordedAt: reading.recordedAt,
  }));
}

/** The SVG path through the points, in order; empty without two of them. */
export function linePath(points: readonly Pick<LinePoint, "x" | "y">[]): string {
  if (points.length < 2) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${round(point.x)} ${round(point.y)}`).join(" ");
}

export interface BarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  value: number;
  recordedAt: string;
  /** True for a zero, drawn as a stub on the baseline. */
  zero: boolean;
}

/** One bar per reading, evenly spaced, from the baseline (zero, or the domain's floor) up to its value. */
export function barRects(readings: readonly Pick<ResponsibilityMetricPoint, "value" | "recordedAt">[], domain: Domain): BarRect[] {
  if (readings.length === 0) return [];
  const slot = CHART_WIDTH / readings.length;
  const width = slot * (1 - BAR_GAP_SHARE);
  const base = yFor(domain, Math.max(domain.min, Math.min(0, domain.max)));
  return readings.map((reading, index) => {
    const top = yFor(domain, reading.value);
    const zero = reading.value === 0;
    const height = zero ? ZERO_BAR_HEIGHT : Math.max(ZERO_BAR_HEIGHT, Math.abs(base - top));
    return {
      x: index * slot + (slot - width) / 2,
      y: zero ? base - ZERO_BAR_HEIGHT : Math.min(base, top),
      width,
      height,
      value: reading.value,
      recordedAt: reading.recordedAt,
      zero,
    };
  });
}

/** A share of the chart's height, 0 at the top, for placing an HTML label at a y. */
export function topShare(y: number) {
  return Math.min(1, Math.max(0, y / CHART_HEIGHT));
}

/** A share of the chart's width, for placing an HTML marker at an x. */
export function leftShare(x: number) {
  return Math.min(1, Math.max(0, x / CHART_WIDTH));
}

/** For a ring of radius `radius`: the stroke dash that fills `share` (0 to 1) of it. */
export function ringDash(share: number, radius: number) {
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * Math.min(1, Math.max(0, share));
  return { circumference, dasharray: `${round(filled)} ${round(circumference - filled)}` };
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** A value as the metric shows it: "Yes"/"No" for a yes-or-no bar, otherwise with its unit. */
export function formatMetricViewValue(metric: Pick<ResponsibilityMetricView, "kind" | "unit" | "display">, value: number): string {
  if (metric.kind === "yes_no") return value >= 1 ? "Yes" : "No";
  return formatMetricValue(value, metric.display === "percent" ? "%" : metric.unit);
}

/** "Nov 9": a short date for an axis or a table. */
export function formatChartDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** What the metric aims for, in words: "target at least 20", "target at most 2 days", "range 12–24 months", "the bar is yes"; null without one. */
export function describeMetricTarget(metric: Pick<ResponsibilityMetricView, "kind" | "unit" | "display" | "target" | "direction" | "low" | "high">): string | null {
  if (metric.kind === "yes_no") return "the bar is yes";
  if (metric.kind === "range" && metric.low !== null && metric.high !== null) return `range ${formatMetricRange(metric.low, metric.high, metric.unit)}`;
  if (metric.target === null) return null;
  const target = formatMetricValue(metric.target, metric.display === "percent" ? "%" : metric.unit);
  return metric.direction === "at_most" ? `target at most ${target}` : `target ${target}`;
}

/** The reference lines a chart draws: the target, or a range's two bounds. */
export function metricReferences(metric: Pick<ResponsibilityMetricView, "kind" | "unit" | "display" | "target" | "direction" | "low" | "high">): { value: number; label: string }[] {
  if (metric.kind === "range" && metric.low !== null && metric.high !== null) {
    return [
      { value: metric.high, label: `High ${formatMetricViewValue(metric, metric.high)}` },
      { value: metric.low, label: `Low ${formatMetricViewValue(metric, metric.low)}` },
    ];
  }
  if (metric.target === null || metric.kind === "yes_no") return [];
  return [{ value: metric.target, label: `${metric.direction === "at_most" ? "At most" : "Target"} ${formatMetricViewValue(metric, metric.target)}` }];
}

/**
 * The chart's text alternative, one sentence: "Line over time of Reply time:
 * 8 readings from Oct 1 to Nov 16, latest 2 days, target at most 2 days."
 */
export function describeMetricChart(metric: ResponsibilityMetricView): string {
  const form = metric.display === "bar" ? "Bars per week" : metric.display === "line" ? "Line over time" : metric.display === "percent" ? "Percentage" : "Number";
  const target = describeMetricTarget(metric);
  const tail = target ? `, ${target}` : "";
  const { readings } = metric;
  if (readings.length === 0) return `${form} of ${metric.title}: no readings yet${tail}.`;
  const latest = formatMetricViewValue(metric, readings.at(-1)!.value);
  if (metric.display === "number" || metric.display === "percent" || readings.length === 1) {
    return `${form} of ${metric.title}: ${latest}${readings.length === 1 && metric.display !== "number" && metric.display !== "percent" ? ", one reading so far" : ""}${tail}.`;
  }
  const values = readings.map((reading) => reading.value);
  const low = formatMetricViewValue(metric, Math.min(...values));
  const high = formatMetricViewValue(metric, Math.max(...values));
  const span = metric.display === "bar"
    ? `${readings.length} weeks from ${formatChartDate(readings[0]!.recordedAt)}`
    : `${readings.length} readings from ${formatChartDate(readings[0]!.recordedAt)} to ${formatChartDate(readings.at(-1)!.recordedAt)}`;
  return `${form} of ${metric.title}: ${span}, between ${low} and ${high}, latest ${latest}${tail}.`;
}

// ---------------------------------------------------------------------------
// A proposal's metric set, as it will appear
// ---------------------------------------------------------------------------

/**
 * The metric set a bar proposal carries, as the bar module will draw it once
 * accepted: the bar's own metric first (with the proposed reading, if any),
 * then each supporting metric with its starting readings. Null when the
 * proposal leaves the set as it is.
 */
export function proposalMetricPreview(
  payload: Pick<ProposeResponsibilityBarPayload, "bar" | "metricCurrent" | "preview" | "primaryDisplay" | "metrics">,
  now: Date,
): { primary: ResponsibilityMetricSummary; metrics: ResponsibilityMetricView[]; keepsSupporting: boolean } | null {
  if ((payload.metrics ?? null) === null && (payload.primaryDisplay ?? null) === null) return null;
  const bar = responsibilityBarMetricFromProposal(payload.bar);
  const current = payload.metricCurrent;
  const primary: ResponsibilityMetricSummary = {
    ...bar,
    current,
    attainment: responsibilityAttainment(bar, current),
    statusRule: responsibilityStatusRule(bar),
    updatedAt: current === null ? null : now,
    stale: false,
  };
  const point = (value: number, recordedAt: string) => ({ id: null, value, recordedAt, recordedByAgentId: null, recordedByUserId: null });
  const primaryReadings = current === null ? [] : [point(current, now.toISOString())];
  const primaryView: ResponsibilityMetricView = {
    key: "primary",
    id: null,
    role: "primary",
    starter: null,
    title: bar.name,
    description: primary.statusRule,
    display: payload.primaryDisplay ?? defaultPrimaryDisplay(bar.kind, primaryReadings.length),
    unit: bar.unit,
    target: bar.target,
    direction: bar.direction,
    kind: bar.kind,
    low: bar.low,
    high: bar.high,
    latest: primaryReadings.at(-1) ?? null,
    readings: primaryReadings,
    period: payload.primaryDisplay === "bar" ? "week" : null,
    stale: false,
    note: null,
    health: payload.preview?.health ?? "not_measured",
  };
  const supporting = (payload.metrics ?? []).map((metric, index): ResponsibilityMetricView => {
    const readings = metric.readings.map((reading) => point(reading.value, reading.recordedAt));
    return {
      key: `proposed:${index}`,
      id: null,
      role: "supporting",
      starter: null,
      title: metric.title,
      description: metric.description,
      display: metric.display,
      unit: metric.unit,
      target: metric.target,
      direction: metric.direction,
      kind: null,
      low: null,
      high: null,
      latest: readings.at(-1) ?? null,
      readings,
      period: metric.display === "bar" ? "week" : null,
      stale: false,
      note: null,
      health: null,
    };
  });
  return { primary, metrics: [primaryView, ...supporting], keepsSupporting: payload.metrics === null || payload.metrics === undefined };
}
