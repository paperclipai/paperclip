import { z } from "zod";
import {
  RESPONSIBILITY_AT_RISK_THRESHOLD,
  RESPONSIBILITY_HEALTH,
  RESPONSIBILITY_METRIC_DIRECTIONS,
  type ResponsibilityHealth,
  type ResponsibilityMetricDirection,
} from "./constants.js";
import type { ProposeResponsibilityBarInteraction } from "./types/issue.js";
import {
  RESPONSIBILITY_METRIC_DISPLAYS,
  RESPONSIBILITY_SUPPORTING_METRIC_LIMIT,
  primaryDisplaysFor,
  responsibilityMetricDefinitionPayloadSchema,
  responsibilityMetricDefinitionSchema,
  type ResponsibilityMetricDefinition,
  type ResponsibilityMetricDisplay,
} from "./responsibility-metrics.js";

/**
 * Bar templates for responsibilities (experimental, `enableResponsibilities`).
 *
 * A responsibility's bar is a sentence plus a metric. The metric follows one
 * template, and each template has its own inputs, its own reading and its own
 * rule for status. Everything a template means lives in this file: add a kind
 * to `RESPONSIBILITY_METRIC_KINDS` and an entry to `RESPONSIBILITY_BAR_TEMPLATES`
 * (TypeScript then points at every switch that must learn it). Status for every
 * template comes from one attainment figure (1 means the bar is met):
 * attainment >= 1 is on track, >= `RESPONSIBILITY_AT_RISK_THRESHOLD` is at
 * risk, anything lower is behind, and no attainment is not measured.
 */

export const RESPONSIBILITY_METRIC_KINDS = ["volume", "percentage", "yes_no", "range"] as const;
export type ResponsibilityMetricKind = (typeof RESPONSIBILITY_METRIC_KINDS)[number];

/** The metric inputs a template may use besides the metric name. */
export const RESPONSIBILITY_BAR_FIELDS = ["metricUnit", "metricDirection", "metricTarget", "metricLow", "metricHigh"] as const;
export type ResponsibilityBarField = (typeof RESPONSIBILITY_BAR_FIELDS)[number];

/** A bar's metric as status derivation reads it. `name` is trimmed and non-empty. */
export interface ResponsibilityBarMetric {
  kind: ResponsibilityMetricKind;
  name: string;
  unit: string | null;
  /** Volume and percentage only; null for the other templates. */
  direction: ResponsibilityMetricDirection | null;
  /** Volume and percentage only. */
  target: number | null;
  /** Range only: the lowest value that is still inside. */
  low: number | null;
  /** Range only: the highest value that is still inside. */
  high: number | null;
}

export interface ResponsibilityBarTemplate {
  kind: ResponsibilityMetricKind;
  /** Person-facing name: "Volume", "Yes or no". */
  label: string;
  /** One person-facing line on what the template measures. */
  summary: string;
  /** When an agent should pick it. */
  whenItFits: string;
  /** Inputs this template uses besides the metric name; any other input must be empty. */
  fields: readonly ResponsibilityBarField[];
  /** Inputs a complete bar of this template needs (with `standard` and `metricName`). */
  required: readonly ResponsibilityBarField[];
  /** How a reading is reported through `metricCurrent`. */
  readingHelp: string;
  /** A complete example bar, valid against the create and proposal schemas. */
  example: {
    standard: string;
    metricName: string;
    metricUnit?: string;
    metricDirection?: ResponsibilityMetricDirection;
    metricTarget?: number;
    metricLow?: number;
    metricHigh?: number;
    metricCurrent?: number | boolean;
  };
}

export const RESPONSIBILITY_BAR_TEMPLATES: Record<ResponsibilityMetricKind, ResponsibilityBarTemplate> = {
  volume: {
    kind: "volume",
    label: "Volume",
    summary: "A count or amount that should be at least, or at most, a target.",
    whenItFits:
      "Something you count or add up: replies owed, deals in the pipeline, days to close, open bugs, revenue. at_least when more is better, at_most when it should stay down.",
    fields: ["metricUnit", "metricDirection", "metricTarget"],
    required: ["metricTarget"],
    readingHelp: "the current count or amount, as a number",
    example: {
      standard: "No escalated ticket waits a full day for a first reply.",
      metricName: "Escalated tickets waiting over a day",
      metricDirection: "at_most",
      metricTarget: 0,
    },
  },
  percentage: {
    kind: "percentage",
    label: "Percentage",
    summary: "A share from 0 to 100 that should be at least, or at most, a target.",
    whenItFits:
      "A share of a whole: the part of investors contacted this fortnight, invoices paid on time, churned customers. The unit is always %.",
    fields: ["metricDirection", "metricTarget"],
    required: ["metricTarget"],
    readingHelp: "the current share as a number from 0 to 100",
    example: {
      standard: "Every prospective LP hears from us at least every two weeks.",
      metricName: "Prospective LPs contacted in the last 14 days",
      metricDirection: "at_least",
      metricTarget: 90,
    },
  },
  yes_no: {
    kind: "yes_no",
    label: "Yes or no",
    summary: "A state that is either true or not. Yes is on track; no is behind.",
    whenItFits:
      "A commitment that is simply kept or not, with nothing to count: the board pack went out a week before the meeting, payroll was approved by the 25th. The metric name is the statement that should be true.",
    fields: [],
    required: [],
    readingHelp: "true when the statement holds today, false when it does not",
    example: {
      standard: "Directors get the board pack a full week before every meeting.",
      metricName: "Board pack sent a week before the next meeting",
    },
  },
  range: {
    kind: "range",
    label: "Range",
    summary: "A value that should stay between a low and a high bound.",
    whenItFits:
      "A level that is wrong when too low and wrong when too high: runway in months, inventory on hand, team utilisation, cash in the operating account.",
    fields: ["metricUnit", "metricLow", "metricHigh"],
    required: ["metricLow", "metricHigh"],
    readingHelp: "the current value, as a number",
    example: {
      standard: "We always have between 12 and 24 months of runway.",
      metricName: "Runway",
      metricUnit: "months",
      metricLow: 12,
      metricHigh: 24,
    },
  },
};

// ---------------------------------------------------------------------------
// Reading a stored row
// ---------------------------------------------------------------------------

export function isResponsibilityMetricKind(value: unknown): value is ResponsibilityMetricKind {
  return typeof value === "string" && (RESPONSIBILITY_METRIC_KINDS as readonly string[]).includes(value);
}

/**
 * The template a stored row follows. Rows saved before templates existed
 * have no kind: a "%" unit reads as a percentage, anything else as a volume.
 */
export function resolveResponsibilityMetricKind(kind: string | null | undefined, unit: string | null | undefined): ResponsibilityMetricKind {
  if (isResponsibilityMetricKind(kind)) return kind;
  return unit?.trim() === "%" ? "percentage" : "volume";
}

/** Whether a template reads a target with a direction (volume and percentage). */
export function responsibilityKindHasTarget(kind: ResponsibilityMetricKind) {
  return RESPONSIBILITY_BAR_TEMPLATES[kind].fields.includes("metricTarget");
}

// ---------------------------------------------------------------------------
// Attainment and status
// ---------------------------------------------------------------------------

function round4(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Volume and percentage attainment, 1 meaning met. `at_least`: current /
 * target when target > 0 (floored at 0). `at_most`: target / current when
 * both are > 0. Every other case is pass/fail because a ratio would be
 * meaningless (target <= 0, or an `at_most` reading <= 0): 1 when met, else 0.
 */
export function directionalAttainment(
  direction: ResponsibilityMetricDirection,
  target: number | null,
  current: number | null,
): number | null {
  if (target === null || current === null || !Number.isFinite(target) || !Number.isFinite(current)) return null;
  let value: number;
  if (direction === "at_most") {
    value = target > 0 && current > 0 ? target / current : current <= target ? 1 : 0;
  } else {
    value = target > 0 ? Math.max(0, current / target) : current >= target ? 1 : 0;
  }
  return round4(value);
}

/**
 * How far a reading is toward the bar, 1 meaning met, rounded to 4 places; null
 * when there is no reading or the bar is incomplete.
 * - volume and percentage: `directionalAttainment`.
 * - yes_no: 1 for yes, 0 for no (so status is on track or behind, never at risk).
 * - range: 1 inside the bounds; outside, 1 - distance / width, floored at 0. A
 *   reading a quarter of the width outside is exactly the at-risk threshold.
 */
export function responsibilityAttainment(metric: ResponsibilityBarMetric, current: number | null): number | null {
  if (current === null || !Number.isFinite(current)) return null;
  switch (metric.kind) {
    case "volume":
    case "percentage":
      return directionalAttainment(metric.direction ?? "at_least", metric.target, current);
    case "yes_no":
      return current === 1 ? 1 : 0;
    case "range": {
      const { low, high } = metric;
      if (low === null || high === null || !(high > low)) return null;
      if (current >= low && current <= high) return 1;
      const distance = current < low ? low - current : current - high;
      return round4(Math.max(0, 1 - distance / (high - low)));
    }
  }
}

/** on_track at >= 1, at_risk at >= `RESPONSIBILITY_AT_RISK_THRESHOLD`, behind below; not_measured without attainment. */
export function responsibilityHealthFromAttainment(attainment: number | null): ResponsibilityHealth {
  if (attainment === null) return "not_measured";
  if (attainment >= 1) return "on_track";
  if (attainment >= RESPONSIBILITY_AT_RISK_THRESHOLD) return "at_risk";
  return "behind";
}

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function isSymbolUnit(unit: string) {
  return !/[A-Za-z]/.test(unit);
}

/**
 * A value with its unit: "%" is a suffix ("60%"), any other unit without
 * letters is a prefix ("$1,200"), and a word unit follows with a space ("3
 * days") unless `withWordUnit` is false.
 */
export function formatResponsibilityMetricValue(value: number, unit: string | null, withWordUnit = true): string {
  const text = numberFormat.format(value);
  if (!unit) return text;
  if (unit === "%") return `${text}%`;
  if (isSymbolUnit(unit)) return value < 0 ? `-${unit}${numberFormat.format(-value)}` : `${unit}${text}`;
  return withWordUnit ? `${text} ${unit}` : text;
}

/** Lower-case the first letter unless the name starts with an acronym ("NPS"). */
function inSentence(name: string) {
  if (name.length > 1 && /[A-Z]/.test(name[1]!)) return name;
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** The unit as values show it: always "%" for a percentage. */
function displayUnit(metric: Pick<ResponsibilityBarMetric, "kind" | "unit">) {
  if (metric.kind === "percentage") return "%";
  if (metric.kind === "yes_no") return null;
  return metric.unit?.trim() || null;
}

/** A word unit is left out when the metric name already contains it ("Runway in months"). */
function wordUnitOk(metric: Pick<ResponsibilityBarMetric, "kind" | "unit" | "name">) {
  const unit = displayUnit(metric);
  return unit !== null && !metric.name.toLowerCase().includes(unit.toLowerCase());
}

/** A reading in plain words: "60%", "$1,200", "3 days", "Yes". */
export function formatResponsibilityReading(metric: ResponsibilityBarMetric, value: number): string {
  if (metric.kind === "yes_no") return value === 1 ? "Yes" : "No";
  return formatResponsibilityMetricValue(value, displayUnit(metric), wordUnitOk(metric));
}

/** What the bar asks for: "At least 90%", "At most 2 days", "Yes", "Between 12 and 24 months". Null when incomplete. */
export function responsibilityTargetLabel(metric: ResponsibilityBarMetric): string | null {
  const unit = displayUnit(metric);
  const words = wordUnitOk(metric);
  switch (metric.kind) {
    case "volume":
    case "percentage":
      if (metric.target === null) return null;
      return `${metric.direction === "at_most" ? "At most" : "At least"} ${formatResponsibilityMetricValue(metric.target, unit, words)}`;
    case "yes_no":
      return "Yes";
    case "range":
      if (metric.low === null || metric.high === null) return null;
      return `Between ${formatResponsibilityMetricValue(metric.low, unit, false)} and ${formatResponsibilityMetricValue(metric.high, unit, words)}`;
  }
}

/**
 * The deterministic status sentence (no trailing period):
 * - volume at_least: "{current} of {target} {metric}, {pct}% of target"
 *   ("12 of 20 investors contacted, 60% of target"); when the target is <= 0:
 *   "…, target met" / "…, below target".
 * - percentage at_least: "{Metric}: {current}% against a target of at least
 *   {target}%" ("Updates sent on time: 90% against a target of at least 100%").
 * - at_most (volume and percentage): "{Metric}: {current} against a target of
 *   at most {target}" ("Reply time: 3 days against a target of at most 2 days").
 * - yes_no: "{Metric}: yes" / "{Metric}: no, the bar is yes".
 * - range: "{Metric}: {current}, inside the range of {low} to {high}" or
 *   "…, {distance} below/above the range of {low} to {high}".
 * - not measured: "Not measured: no metric is set", "Not measured: {metric}
 *   has no target" (or "has no range"), "Not measured yet: no reading of
 *   {metric} against a target of {target}" (or "against a range of …"), "Not
 *   measured yet: no yes-or-no reading of {metric}".
 * A word unit is left out when the metric name already contains it.
 */
export function responsibilityStatusSentence(
  metric: ResponsibilityBarMetric | null,
  current: number | null,
  attainment: number | null = metric ? responsibilityAttainment(metric, current) : null,
): string {
  if (!metric) return "Not measured: no metric is set";
  const label = inSentence(metric.name);
  const unit = displayUnit(metric);
  const words = wordUnitOk(metric);
  switch (metric.kind) {
    case "yes_no":
      if (current === null) return `Not measured yet: no yes-or-no reading of ${label}`;
      return current === 1 ? `${metric.name}: yes` : `${metric.name}: no, the bar is yes`;
    case "range": {
      const { low, high } = metric;
      if (low === null || high === null) return `Not measured: ${label} has no range`;
      const range = `${formatResponsibilityMetricValue(low, unit, false)} to ${formatResponsibilityMetricValue(high, unit, words)}`;
      if (current === null) return `Not measured yet: no reading of ${label} against a range of ${range}`;
      const reading = formatResponsibilityMetricValue(current, unit, words);
      if (current >= low && current <= high) return `${metric.name}: ${reading}, inside the range of ${range}`;
      const below = current < low;
      const distance = formatResponsibilityMetricValue(below ? low - current : current - high, unit, words);
      return `${metric.name}: ${reading}, ${distance} ${below ? "below" : "above"} the range of ${range}`;
    }
    case "volume":
    case "percentage": {
      if (metric.target === null) return `Not measured: ${label} has no target`;
      const atMost = metric.direction === "at_most";
      const target = formatResponsibilityMetricValue(metric.target, unit, words);
      if (current === null) {
        return `Not measured yet: no reading of ${label} against a target of ${atMost ? "at most " : ""}${target}`;
      }
      if (atMost) {
        return `${metric.name}: ${formatResponsibilityMetricValue(current, unit, words)} against a target of at most ${target}`;
      }
      // A percentage is already a share, so "80% of 100% …, 80% of target" says
      // the same thing three ways. Read it like the at-most form instead.
      if (metric.kind === "percentage") {
        return `${metric.name}: ${formatResponsibilityMetricValue(current, unit)} against a target of at least ${target}`;
      }
      const head = `${formatResponsibilityMetricValue(current, unit, false)} of ${target} ${label}`;
      if (metric.target <= 0) return `${head}, ${current >= metric.target ? "target met" : "below target"}`;
      return `${head}, ${Math.round((attainment ?? 0) * 100)}% of target`;
    }
  }
}

const NEARLY = 1e-9;

/**
 * One line on how status is read for this bar, null when it is incomplete:
 * "On track at 90% or more; at risk from 68%", "On track at 2 days or less; at
 * risk up to 2.67 days", "On track when the answer is yes; behind when it is
 * no", "On track between 12 and 24 months; at risk up to 3 months outside it".
 * Percentage thresholds are whole numbers, rounded toward the bar.
 */
export function responsibilityStatusRule(metric: ResponsibilityBarMetric): string | null {
  const unit = displayUnit(metric);
  const words = wordUnitOk(metric);
  const fmt = (value: number) => formatResponsibilityMetricValue(value, unit, words);
  switch (metric.kind) {
    case "yes_no":
      return "On track when the answer is yes; behind when it is no";
    case "range": {
      const { low, high } = metric;
      if (low === null || high === null || !(high > low)) return null;
      const band = (high - low) * (1 - RESPONSIBILITY_AT_RISK_THRESHOLD);
      return `On track between ${formatResponsibilityMetricValue(low, unit, false)} and ${fmt(high)}; at risk up to ${fmt(band)} outside it; behind further out`;
    }
    case "volume":
    case "percentage": {
      const target = metric.target;
      if (target === null) return null;
      const whole = metric.kind === "percentage";
      if (metric.direction === "at_most") {
        if (target <= 0) return `On track at ${fmt(target)} or less; behind above that`;
        const limit = target / RESPONSIBILITY_AT_RISK_THRESHOLD;
        return `On track at ${fmt(target)} or less; at risk up to ${fmt(whole ? Math.floor(limit + NEARLY) : limit)}`;
      }
      if (target <= 0) return `On track at ${fmt(target)} or more; behind below that`;
      const floor = target * RESPONSIBILITY_AT_RISK_THRESHOLD;
      return `On track at ${fmt(target)} or more; at risk from ${fmt(whole ? Math.ceil(floor - NEARLY) : floor)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Metric values are plain finite numbers; the database stores them as numeric. */
export const responsibilityMetricValueSchema = z.number().finite().min(-1e15).max(1e15);
/** A reading: a number, or true/false for a yes-or-no bar. */
export const responsibilityMetricReadingSchema = z.union([responsibilityMetricValueSchema, z.boolean()]);
export const responsibilityMetricUnitSchema = z.string().trim().min(1).max(40);
export const responsibilityMetricNameSchema = z.string().trim().min(1).max(200);

/** The bar inputs a request may carry. `undefined` means "not sent"; `null` means "empty". */
export interface ResponsibilityBarInput {
  metricKind: ResponsibilityMetricKind;
  metricUnit?: string | null;
  metricDirection?: ResponsibilityMetricDirection | null;
  metricTarget?: number | null;
  metricLow?: number | null;
  metricHigh?: number | null;
  metricCurrent?: number | boolean | null;
}

export interface ResponsibilityBarIssue {
  field: ResponsibilityBarField | "metricCurrent";
  message: string;
}

const FIELD_WORDS: Record<ResponsibilityBarField, string> = {
  metricUnit: "a unit",
  metricDirection: "a direction",
  metricTarget: "a target",
  metricLow: "a low bound",
  metricHigh: "a high bound",
};

const UNUSED_FIELD_MESSAGE: Record<ResponsibilityMetricKind, string> = {
  volume: "A volume bar has a target and a direction, not a range; use the range template for low and high bounds",
  percentage: "A percentage bar has a target and a direction, not a range or another unit (its unit is always %)",
  yes_no: "A yes-or-no bar has no unit, direction, target or range: yes is on track and no is behind",
  range: "A range bar has a low and a high bound instead of a target and a direction",
};

function present(value: unknown) {
  return value !== undefined && value !== null;
}

/** Problems with a reading for a template; null when it is acceptable. Null readings are always acceptable. */
export function responsibilityReadingIssue(kind: ResponsibilityMetricKind, value: number | boolean | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (kind === "yes_no") {
    if (typeof value === "boolean" || value === 0 || value === 1) return null;
    return "A yes-or-no reading is true or false (or 1 or 0)";
  }
  if (typeof value === "boolean") return "metricCurrent is true or false only for a yes-or-no bar; send the reading as a number";
  if (kind === "percentage" && (value < 0 || value > 100)) return "A percentage reading is a share from 0 to 100";
  return null;
}

/** A reading as stored: yes is 1 and no is 0. */
export function normalizeResponsibilityReading(value: number | boolean): number;
export function normalizeResponsibilityReading(value: number | boolean | null): number | null;
export function normalizeResponsibilityReading(value: number | boolean | null): number | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/**
 * Field problems for a bar of `metricKind`: inputs the template does not use,
 * values outside its rules, and (with `complete`) inputs it requires.
 */
export function responsibilityBarIssues(
  input: ResponsibilityBarInput,
  options: { complete: boolean },
): ResponsibilityBarIssue[] {
  const kind = input.metricKind;
  const template = RESPONSIBILITY_BAR_TEMPLATES[kind];
  const issues: ResponsibilityBarIssue[] = [];
  for (const field of RESPONSIBILITY_BAR_FIELDS) {
    const value = input[field];
    if (!present(value)) {
      if (options.complete && template.required.includes(field)) {
        issues.push({ field, message: `A ${template.label.toLowerCase()} bar needs ${FIELD_WORDS[field]} (${field})` });
      }
      continue;
    }
    if (field === "metricUnit" && kind === "percentage") {
      if (String(value).trim() !== "%") issues.push({ field, message: "A percentage bar's unit is always %" });
      continue;
    }
    if (!template.fields.includes(field)) {
      issues.push({ field, message: UNUSED_FIELD_MESSAGE[kind] });
      continue;
    }
    if (field === "metricUnit" && kind === "volume" && String(value).trim() === "%") {
      issues.push({ field, message: "A share belongs in the percentage template; a volume's unit cannot be %" });
    }
  }
  if (kind === "percentage" && present(input.metricTarget) && (input.metricTarget! < 0 || input.metricTarget! > 100)) {
    issues.push({ field: "metricTarget", message: "A percentage target is a share from 0 to 100" });
  }
  if (kind === "range" && present(input.metricLow) && present(input.metricHigh) && !(input.metricHigh! > input.metricLow!)) {
    issues.push({ field: "metricHigh", message: "A range's high bound (metricHigh) must be above its low bound (metricLow)" });
  }
  const reading = responsibilityReadingIssue(kind, input.metricCurrent);
  if (reading) issues.push({ field: "metricCurrent", message: reading });
  return issues;
}

/** A stored row's bar inputs, as completeness checks read them. */
export interface ResponsibilityBarRow {
  standard: string | null;
  metricName: string | null;
  metricKind?: string | null;
  metricUnit?: string | null;
  metricTarget?: number | string | null;
  metricLow?: number | string | null;
  metricHigh?: number | string | null;
  metricCurrent?: number | string | null;
}

/**
 * Whether a row carries any part of a metric: what is measured, a target, a
 * bound or a reading. The template, unit and direction alone do not count:
 * they can linger on a row whose metric was never set.
 */
export function responsibilityHasMetric(row: Omit<ResponsibilityBarRow, "standard">): boolean {
  return !!row.metricName?.trim()
    || [row.metricTarget, row.metricLow, row.metricHigh, row.metricCurrent].some((value) => value !== null && value !== undefined);
}

/**
 * The bar fields, by API name, a responsibility needs before it can be active.
 *
 * With `barOptional` (a person confirming or keeping their own
 * responsibility), a row with no metric at all needs nothing: it is active
 * and reads as not measured until its bar is set. A row with any part of a
 * metric still needs the whole bar, so a half-filled metric is never active.
 */
export function responsibilityBarMissingForActive(row: ResponsibilityBarRow, options: { barOptional?: boolean } = {}): string[] {
  if (options.barOptional && !responsibilityHasMetric(row)) return [];
  const missing: string[] = [];
  if (!row.standard?.trim()) missing.push("standard");
  if (!row.metricName?.trim()) missing.push("metricName");
  const kind = resolveResponsibilityMetricKind(row.metricKind, row.metricUnit);
  for (const field of RESPONSIBILITY_BAR_TEMPLATES[kind].required) {
    const value = (row as unknown as Record<string, unknown>)[field];
    if (value === null || value === undefined) missing.push(field);
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Bar proposals: an agent proposes a bar in a bar conversation
// ---------------------------------------------------------------------------

/** The bar as a proposal carries it, normalized for its template (unused inputs are null). */
export interface ResponsibilityBarProposalBar {
  standard: string;
  metricKind: ResponsibilityMetricKind;
  metricName: string;
  metricUnit: string | null;
  metricDirection: ResponsibilityMetricDirection | null;
  metricTarget: number | null;
  metricLow: number | null;
  metricHigh: number | null;
}

export interface ProposeResponsibilityBarPayload {
  version: 1;
  responsibilityId: string;
  /** The responsibility's title when the proposal was made. */
  responsibilityTitle: string;
  bar: ResponsibilityBarProposalBar;
  /** A reading the agent counted from real evidence; null when it has none. Yes is 1 and no is 0. */
  metricCurrent: number | null;
  /** How the agent got the reading; set whenever `metricCurrent` is. */
  currentEvidence: string | null;
  /** The agent's one plain sentence to the person. */
  message: string | null;
  /** Server-derived plain words, so the card always matches what accepting applies. */
  templateLabel: string;
  targetLabel: string;
  readingLabel: string | null;
  statusRule: string;
  /** The status this bar would show with the proposed reading; null without one. */
  preview: { health: ResponsibilityHealth; statusSentence: string } | null;
  /**
   * How the primary metric is drawn; null (or absent, on proposals made
   * before metric sets) leaves it to the default rule.
   */
  primaryDisplay?: ResponsibilityMetricDisplay | null;
  /**
   * The supporting metrics (at most `RESPONSIBILITY_SUPPORTING_METRIC_LIMIT`),
   * normalized. Accepting replaces the responsibility's supporting metrics
   * with these. Null (or absent) leaves its metric set as it is.
   */
  metrics?: ResponsibilityMetricDefinition[] | null;
}

/**
 * `replaced`: a newer proposal took its place. `issue_closed`: the conversation
 * was cancelled. `withdrawn` and `addressee_deleted` are the administrative
 * outcomes every conversation card can reach.
 */
export const PROPOSE_RESPONSIBILITY_BAR_OUTCOMES = [
  "accepted",
  "declined",
  "replaced",
  "issue_closed",
  "withdrawn",
  "addressee_deleted",
] as const;
export type ProposeResponsibilityBarOutcome = (typeof PROPOSE_RESPONSIBILITY_BAR_OUTCOMES)[number];

export interface ProposeResponsibilityBarResult {
  version: 1;
  outcome: ProposeResponsibilityBarOutcome;
  reason?: string | null;
  /** For `replaced`: the proposal that took its place. */
  replacedByInteractionId?: string | null;
  /** For `accepted`: the responsibility the bar was applied to. */
  responsibilityId?: string | null;
  /** For `accepted`: titles of the supporting metrics the person dropped before accepting. */
  droppedMetrics?: string[] | null;
}

const proposalStandard = z.string().trim().min(1).max(1000);

/** Body an agent sends to propose a bar from its bar conversation. It picks the template. */
export const createResponsibilityBarProposalSchema = z
  .object({
    /** The bar, as a sentence. */
    standard: proposalStandard,
    metricKind: z.enum(RESPONSIBILITY_METRIC_KINDS),
    /** What is measured; for yes_no, the statement that should be true. */
    metricName: responsibilityMetricNameSchema,
    metricUnit: responsibilityMetricUnitSchema.optional().nullable(),
    metricDirection: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).optional().nullable(),
    metricTarget: responsibilityMetricValueSchema.optional().nullable(),
    metricLow: responsibilityMetricValueSchema.optional().nullable(),
    metricHigh: responsibilityMetricValueSchema.optional().nullable(),
    /** Only a reading counted from real evidence; true/false for yes_no. */
    metricCurrent: responsibilityMetricReadingSchema.optional().nullable(),
    /** Required with metricCurrent: how the reading was counted. */
    currentEvidence: z.string().trim().min(1).max(1000).optional().nullable(),
    message: z.string().trim().min(1).max(500).optional().nullable(),
    /** How the primary metric (the bar's own) is drawn; leave it out for the default. */
    primaryDisplay: z.enum(RESPONSIBILITY_METRIC_DISPLAYS).optional().nullable(),
    /**
     * Up to two supporting metrics. Sending them (even an empty list) replaces
     * the responsibility's supporting metrics when the person accepts; leave
     * them out to keep the ones it has.
     */
    metrics: z.array(responsibilityMetricDefinitionSchema).max(RESPONSIBILITY_SUPPORTING_METRIC_LIMIT).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const issue of responsibilityBarIssues(value, { complete: true })) {
      ctx.addIssue({ code: "custom", path: [issue.field], message: issue.message });
    }
    if (present(value.metricCurrent) && !value.currentEvidence) {
      ctx.addIssue({
        code: "custom",
        path: ["currentEvidence"],
        message: "Say how you got the reading in currentEvidence, or leave metricCurrent out",
      });
    }
    if (present(value.primaryDisplay) && !primaryDisplaysFor(value.metricKind).includes(value.primaryDisplay!)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryDisplay"],
        message: `A ${RESPONSIBILITY_BAR_TEMPLATES[value.metricKind].label.toLowerCase()} bar's metric can be drawn as ${primaryDisplaysFor(value.metricKind).join(", ")}`,
      });
    }
    const titles = new Set<string>([value.metricName.trim().toLowerCase()]);
    value.metrics?.forEach((metric, index) => {
      if ((metric.readings?.length ?? 0) > 0 && !metric.readingsEvidence) {
        ctx.addIssue({
          code: "custom",
          path: ["metrics", index, "readingsEvidence"],
          message: "Say how you got the starting readings in readingsEvidence, or leave readings out",
        });
      }
      const title = metric.title.trim().toLowerCase();
      if (titles.has(title)) {
        ctx.addIssue({
          code: "custom",
          path: ["metrics", index, "title"],
          message: "Each metric measures something different: this title repeats the bar's metric or another supporting metric",
        });
      }
      titles.add(title);
    });
  });
export type CreateResponsibilityBarProposal = z.infer<typeof createResponsibilityBarProposalSchema>;

/**
 * Accepting a proposed bar. `keepMetrics` lists the supporting metrics to
 * apply, by their index in the proposal's `metrics`; the rest are dropped.
 * Leave it out to apply every one. The bar's own metric is always applied.
 */
export const acceptResponsibilityBarProposalSchema = z
  .object({
    keepMetrics: z
      .array(z.number().int().min(0).max(RESPONSIBILITY_SUPPORTING_METRIC_LIMIT - 1))
      .max(RESPONSIBILITY_SUPPORTING_METRIC_LIMIT)
      .refine((indexes) => new Set(indexes).size === indexes.length, "Each kept metric is listed once")
      .optional(),
  })
  .strict();
export type AcceptResponsibilityBarProposal = z.infer<typeof acceptResponsibilityBarProposalSchema>;

export const declineResponsibilityBarProposalSchema = z.object({}).strict();
export type DeclineResponsibilityBarProposal = z.infer<typeof declineResponsibilityBarProposalSchema>;

/** Start (or reopen) the conversation about a responsibility's bar. Omit agentId for the default agent. */
export const startResponsibilityBarConversationSchema = z
  .object({ agentId: z.string().uuid().optional() })
  .strict();
export type StartResponsibilityBarConversation = z.infer<typeof startResponsibilityBarConversationSchema>;

export const proposeResponsibilityBarPayloadSchema = z.object({
  version: z.literal(1),
  responsibilityId: z.string(),
  responsibilityTitle: z.string(),
  bar: z.object({
    standard: z.string(),
    metricKind: z.enum(RESPONSIBILITY_METRIC_KINDS),
    metricName: z.string(),
    metricUnit: z.string().nullable(),
    metricDirection: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).nullable(),
    metricTarget: z.number().nullable(),
    metricLow: z.number().nullable(),
    metricHigh: z.number().nullable(),
  }),
  metricCurrent: z.number().nullable(),
  currentEvidence: z.string().nullable(),
  message: z.string().nullable(),
  templateLabel: z.string(),
  targetLabel: z.string(),
  readingLabel: z.string().nullable(),
  statusRule: z.string(),
  preview: z.object({
    health: z.enum(RESPONSIBILITY_HEALTH),
    statusSentence: z.string(),
  }).nullable(),
  primaryDisplay: z.enum(RESPONSIBILITY_METRIC_DISPLAYS).nullable().optional(),
  metrics: z.array(responsibilityMetricDefinitionPayloadSchema).nullable().optional(),
});

export const proposeResponsibilityBarResultSchema = z.object({
  version: z.literal(1),
  outcome: z.enum(PROPOSE_RESPONSIBILITY_BAR_OUTCOMES),
  reason: z.string().nullable().optional(),
  replacedByInteractionId: z.string().nullable().optional(),
  responsibilityId: z.string().nullable().optional(),
  droppedMetrics: z.array(z.string()).nullable().optional(),
});

/** The metric of a normalized proposal bar, as status derivation reads it. */
export function responsibilityBarMetricFromProposal(bar: ResponsibilityBarProposalBar): ResponsibilityBarMetric {
  return {
    kind: bar.metricKind,
    name: bar.metricName,
    unit: bar.metricUnit,
    direction: bar.metricDirection,
    target: bar.metricTarget,
    low: bar.metricLow,
    high: bar.metricHigh,
  };
}

/**
 * Normalize a bar for its template: unused inputs become null, a percentage's
 * unit is "%", and volume and percentage default to `at_least`. The input must
 * already pass `responsibilityBarIssues`.
 */
export function normalizeResponsibilityBar(input: {
  standard: string;
  metricKind: ResponsibilityMetricKind;
  metricName: string;
  metricUnit?: string | null;
  metricDirection?: ResponsibilityMetricDirection | null;
  metricTarget?: number | null;
  metricLow?: number | null;
  metricHigh?: number | null;
}): ResponsibilityBarProposalBar {
  const template = RESPONSIBILITY_BAR_TEMPLATES[input.metricKind];
  const uses = (field: ResponsibilityBarField) => template.fields.includes(field);
  return {
    standard: input.standard.trim(),
    metricKind: input.metricKind,
    metricName: input.metricName.trim(),
    metricUnit: input.metricKind === "percentage" ? "%" : uses("metricUnit") ? input.metricUnit?.trim() || null : null,
    metricDirection: uses("metricDirection") ? input.metricDirection ?? "at_least" : null,
    metricTarget: uses("metricTarget") ? input.metricTarget ?? null : null,
    metricLow: uses("metricLow") ? input.metricLow ?? null : null,
    metricHigh: uses("metricHigh") ? input.metricHigh ?? null : null,
  };
}

/** Where a responsibility's bar conversation stands. */
export const RESPONSIBILITY_BAR_CONVERSATION_STATES = ["none", "discussing", "proposal_waiting", "settled"] as const;
export type ResponsibilityBarConversationState = (typeof RESPONSIBILITY_BAR_CONVERSATION_STATES)[number];

/** `GET /api/responsibilities/:id/bar-conversation`. */
export interface ResponsibilityBarConversation {
  responsibilityId: string;
  /**
   * `proposal_waiting`: a proposed bar waits for the person. `discussing`: the
   * conversation is open with no proposal waiting. `settled`: the latest
   * conversation is finished, or its latest proposal was accepted. `none`:
   * there has been no conversation.
   */
  state: ResponsibilityBarConversationState;
  /** The agent a new conversation would be held with; null when no agent in the company can hold one. */
  defaultAgentId: string | null;
  /** The latest conversation that was not cancelled. */
  conversation: {
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
    agentId: string | null;
    createdAt: Date;
  } | null;
  /** The pending proposal, if any (at most one is pending at a time). */
  proposal: ProposeResponsibilityBarInteraction | null;
}
