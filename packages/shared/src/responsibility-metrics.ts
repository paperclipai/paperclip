import { z } from "zod";
import {
  RESPONSIBILITY_METRIC_DIRECTIONS,
  type ResponsibilityHealth,
  type ResponsibilityMetricDirection,
} from "./constants.js";
import type { ResponsibilityMetricKind } from "./responsibility-bars.js";

/**
 * A responsibility's metric set (experimental, `enableResponsibilities`): up
 * to three metrics that track its health, each drawn in the form that suits
 * it. The first is the primary one, the bar's own metric (template, target
 * and reading, which still drive the derived status); its readings are kept
 * as history so it can be charted. The other two are supporting metrics an
 * agent proposes in the bar conversation (or the owner sets), each with a
 * history of readings. A responsibility with no chosen set shows starter
 * metrics computed on read from the work under it (never stored), chosen by
 * `chooseStarterMetrics`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How a metric is drawn: `number` a large number (with its target), `percent`
 * a large percentage with a ring toward its target, `line` its readings over
 * time, `bar` one bar per period (a week).
 */
export const RESPONSIBILITY_METRIC_DISPLAYS = ["number", "percent", "line", "bar"] as const;
export type ResponsibilityMetricDisplay = (typeof RESPONSIBILITY_METRIC_DISPLAYS)[number];

/** Person-facing names of the forms, as the proposal card says them. */
export const RESPONSIBILITY_METRIC_DISPLAY_LABEL: Record<ResponsibilityMetricDisplay, string> = {
  number: "Large number",
  percent: "Percentage",
  line: "Line over time",
  bar: "Bars per week",
};

/** At most this many metrics on a responsibility: the primary plus supporting ones. */
export const RESPONSIBILITY_METRIC_SET_LIMIT = 3;
/** Supporting metrics besides the primary. */
export const RESPONSIBILITY_SUPPORTING_METRIC_LIMIT = RESPONSIBILITY_METRIC_SET_LIMIT - 1;
/** The newest readings the set read returns per metric. */
export const RESPONSIBILITY_METRIC_HISTORY_LIMIT = 12;
/** Starting readings a proposal (or the owner) may give a new metric. */
export const RESPONSIBILITY_METRIC_STARTING_READINGS_LIMIT = 12;
/** Weeks the "tasks finished per week" starter covers. */
export const RESPONSIBILITY_STARTER_WEEKS = 6;
/** The mirror row that carries the primary metric's history sits at this position. */
export const RESPONSIBILITY_PRIMARY_METRIC_POSITION = 0;
/** The path segment that names the primary metric in the readings endpoint. */
export const RESPONSIBILITY_PRIMARY_METRIC_REF = "primary";

/** Starter metrics, computed on read from what the server knows about the work. */
export const RESPONSIBILITY_STARTER_METRIC_KEYS = ["bar_metric", "tasks_finished", "open_tasks", "automation_share"] as const;
export type ResponsibilityStarterMetricKey = (typeof RESPONSIBILITY_STARTER_METRIC_KEYS)[number];

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface ResponsibilityMetricPoint {
  /** The stored reading's id; null for a computed (starter) point. */
  id: string | null;
  value: number;
  /** ISO time the value was read (for a bar, the start of its period). */
  recordedAt: string;
  recordedByAgentId: string | null;
  recordedByUserId: string | null;
}

/** One metric, ready to draw. */
export interface ResponsibilityMetricView {
  /** Stable key: the stored metric id, `primary`, or `starter:<key>`. */
  key: string;
  /** The stored supporting metric's id (for readings and removal); null for the primary and for starters. */
  id: string | null;
  role: "primary" | "supporting";
  /** Which starter this is; null for a chosen metric. */
  starter: ResponsibilityStarterMetricKey | null;
  title: string;
  /** One line on how it is measured; null when nobody said. */
  description: string | null;
  display: ResponsibilityMetricDisplay;
  /** "%" for a percent; a symbol ("$") or a word ("days"). */
  unit: string | null;
  target: number | null;
  /** With a target: `at_least` when more is better. */
  direction: ResponsibilityMetricDirection | null;
  /** Primary only: the bar's template, so a yes or no reads Yes or No and a range draws its band. */
  kind: ResponsibilityMetricKind | null;
  /** Primary range only. */
  low: number | null;
  high: number | null;
  /** The newest reading, or null before the first. */
  latest: ResponsibilityMetricPoint | null;
  /** Oldest first; at most `RESPONSIBILITY_METRIC_HISTORY_LIMIT`. */
  readings: ResponsibilityMetricPoint[];
  /** For a bar: what each reading covers. */
  period: "week" | null;
  /** True when the newest reading is older than `RESPONSIBILITY_METRIC_STALE_DAYS`. */
  stale: boolean;
  /** A short secondary fact beside the value ("2 blocked"); null when none. */
  note: string | null;
  /** Primary only: the bar's derived status, for the status hue. */
  health: ResponsibilityHealth | null;
}

/** `GET /api/responsibilities/:id/metrics`. */
export interface ResponsibilityMetricSet {
  responsibilityId: string;
  /** `chosen`: an agent proposed it and the person accepted, or the owner set it. `starter`: computed from the work. */
  source: "chosen" | "starter";
  /** Who chose it; null for starters. */
  chosenBy: { agentId: string | null; userId: string | null } | null;
  /** At most `RESPONSIBILITY_METRIC_SET_LIMIT`, the primary first. */
  metrics: ResponsibilityMetricView[];
  historyLimit: number;
}

// ---------------------------------------------------------------------------
// The starter rule
// ---------------------------------------------------------------------------

export interface ResponsibilityStarterFacts {
  /** The bar's metric, when it has one. */
  primary: { kind: ResponsibilityMetricKind; readings: number } | null;
  /** Tasks finished per week, oldest first, `RESPONSIBILITY_STARTER_WEEKS` long. */
  finishedByWeek: readonly number[];
  openTasks: number;
  blockedTasks: number;
  /** Automations ÷ (automations + manual tasks), 0–1; null with neither (or when unknown). */
  automationShare: number | null;
}

export interface ResponsibilityStarterChoice {
  key: ResponsibilityStarterMetricKey;
  display: ResponsibilityMetricDisplay;
}

/**
 * How the primary metric is drawn when nobody chose: a percentage as a
 * percent, a yes or no as its answer, anything else as a line once it has two
 * readings, otherwise as a number.
 */
export function defaultPrimaryDisplay(kind: ResponsibilityMetricKind, readings: number): ResponsibilityMetricDisplay {
  if (kind === "percentage") return "percent";
  if (kind === "yes_no") return "number";
  return readings >= 2 ? "line" : "number";
}

/**
 * Which starter metrics to show, at most three, in order:
 * 1. The bar's metric, whenever there is one (it is the bar, even unread).
 * 2. Then only starters with something in them, in this order: open tasks
 *    (number) when any is blocked, tasks finished per week (bar) when any
 *    finished in the window, the automated share (percent) when there is
 *    work to measure it on, open tasks when any is open.
 * 3. With nothing at all, open tasks alone: a zero is an honest number, where
 *    an empty chart says nothing.
 * So a chart with nothing in it is never shown.
 */
export function chooseStarterMetrics(facts: ResponsibilityStarterFacts): ResponsibilityStarterChoice[] {
  const chosen: ResponsibilityStarterChoice[] = [];
  const add = (choice: ResponsibilityStarterChoice) => {
    if (chosen.length >= RESPONSIBILITY_METRIC_SET_LIMIT || chosen.some((entry) => entry.key === choice.key)) return;
    chosen.push(choice);
  };
  if (facts.primary) add({ key: "bar_metric", display: defaultPrimaryDisplay(facts.primary.kind, facts.primary.readings) });
  if (facts.blockedTasks > 0) add({ key: "open_tasks", display: "number" });
  if (facts.finishedByWeek.some((count) => count > 0)) add({ key: "tasks_finished", display: "bar" });
  if (facts.automationShare !== null) add({ key: "automation_share", display: "percent" });
  if (facts.openTasks > 0) add({ key: "open_tasks", display: "number" });
  if (chosen.length === 0) add({ key: "open_tasks", display: "number" });
  return chosen;
}

/**
 * Counts per week ending at `now`, oldest first: bucket `weeks - 1` is the
 * last seven days. Instants outside the window are left out.
 */
export function weeklyCounts(instants: readonly (Date | string)[], now: Date, weeks = RESPONSIBILITY_STARTER_WEEKS): { start: Date; count: number }[] {
  const WEEK_MS = 7 * 86_400_000;
  const end = now.getTime();
  const buckets = Array.from({ length: weeks }, (_, index) => ({
    start: new Date(end - (weeks - index) * WEEK_MS),
    count: 0,
  }));
  for (const instant of instants) {
    const at = new Date(instant).getTime();
    if (!Number.isFinite(at) || at > end) continue;
    const back = Math.floor((end - at) / WEEK_MS);
    if (back >= weeks) continue;
    buckets[weeks - 1 - back]!.count += 1;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const metricValue = z.number().finite().min(-1e15).max(1e15);
/** A minute's grace for clocks that disagree. */
const FUTURE_GRACE_MS = 60_000;

export const responsibilityMetricStartingReadingSchema = z.object({
  value: metricValue,
  /** ISO time the value was true. */
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

function percentIssue(value: number | null | undefined) {
  return value !== undefined && value !== null && (value < 0 || value > 100);
}

/**
 * A supporting metric as an agent proposes it (or the owner sets it): what is
 * measured, how, how it is drawn, an optional unit and target, and optional
 * starting readings from real evidence.
 */
export const responsibilityMetricDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    /** One line on how it is measured. */
    description: z.string().trim().min(1).max(300),
    display: z.enum(RESPONSIBILITY_METRIC_DISPLAYS),
    unit: z.string().trim().min(1).max(40).optional().nullable(),
    target: metricValue.optional().nullable(),
    direction: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).optional().nullable(),
    readings: z.array(responsibilityMetricStartingReadingSchema).max(RESPONSIBILITY_METRIC_STARTING_READINGS_LIMIT).optional(),
    /** How the starting readings were counted; required with readings in a proposal. */
    readingsEvidence: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.display === "percent") {
      if (value.unit && value.unit !== "%") ctx.addIssue({ code: "custom", path: ["unit"], message: "A percent metric's unit is always %" });
      if (percentIssue(value.target)) ctx.addIssue({ code: "custom", path: ["target"], message: "A percent target is a share from 0 to 100" });
      value.readings?.forEach((reading, index) => {
        if (percentIssue(reading.value)) {
          ctx.addIssue({ code: "custom", path: ["readings", index, "value"], message: "A percent reading is a share from 0 to 100" });
        }
      });
    }
    if ((value.direction ?? null) !== null && (value.target ?? null) === null) {
      ctx.addIssue({ code: "custom", path: ["direction"], message: "A direction needs a target; leave both out when there is none" });
    }
    const limit = Date.now() + FUTURE_GRACE_MS;
    value.readings?.forEach((reading, index) => {
      if (new Date(reading.recordedAt).getTime() > limit) {
        ctx.addIssue({ code: "custom", path: ["readings", index, "recordedAt"], message: "A reading cannot be in the future" });
      }
    });
  });
export type ResponsibilityMetricDefinitionInput = z.infer<typeof responsibilityMetricDefinitionSchema>;

/** A supporting metric normalized for storage and for the proposal card. */
export interface ResponsibilityMetricDefinition {
  title: string;
  description: string;
  display: ResponsibilityMetricDisplay;
  unit: string | null;
  target: number | null;
  direction: ResponsibilityMetricDirection | null;
  /** Oldest first. */
  readings: { value: number; recordedAt: string }[];
  readingsEvidence: string | null;
}

/** Normalize a supporting metric: a percent's unit is "%", a target defaults to `at_least`, readings oldest first. */
export function normalizeResponsibilityMetricDefinition(input: ResponsibilityMetricDefinitionInput): ResponsibilityMetricDefinition {
  const target = input.target ?? null;
  return {
    title: input.title.trim(),
    description: input.description.trim(),
    display: input.display,
    unit: input.display === "percent" ? "%" : input.unit?.trim() || null,
    target,
    direction: target === null ? null : input.direction ?? "at_least",
    readings: [...(input.readings ?? [])]
      .map((reading) => ({ value: reading.value, recordedAt: new Date(reading.recordedAt).toISOString() }))
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
    readingsEvidence: input.readingsEvidence?.trim() || null,
  };
}

export const responsibilityMetricDefinitionPayloadSchema = z.object({
  title: z.string(),
  description: z.string(),
  display: z.enum(RESPONSIBILITY_METRIC_DISPLAYS),
  unit: z.string().nullable(),
  target: z.number().nullable(),
  direction: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).nullable(),
  readings: z.array(z.object({ value: z.number(), recordedAt: z.string() })),
  readingsEvidence: z.string().nullable(),
});

/**
 * `PUT /api/responsibilities/:id/metrics`: the owner sets the supporting
 * metrics (replacing any) and, optionally, how the primary is drawn. The path
 * a person uses without a bar conversation; an agent proposes a set there.
 */
export const setResponsibilityMetricsSchema = z
  .object({
    primaryDisplay: z.enum(RESPONSIBILITY_METRIC_DISPLAYS).optional().nullable(),
    metrics: z.array(responsibilityMetricDefinitionSchema).max(RESPONSIBILITY_SUPPORTING_METRIC_LIMIT),
  })
  .strict();
export type SetResponsibilityMetrics = z.infer<typeof setResponsibilityMetricsSchema>;

/**
 * `POST /api/responsibilities/:id/metrics/:metricId/readings` (`metricId` is a
 * supporting metric's id, or `primary`). `recordedAt` (a past time) is for the
 * owner only; an agent records what is true now. `readingId` corrects one of
 * this metric's readings (owner only).
 */
export const recordResponsibilityMetricReadingSchema = z
  .object({
    /** A number; true or false for a yes-or-no primary. */
    value: z.union([metricValue, z.boolean()]),
    recordedAt: z.string().datetime({ offset: true }).optional(),
    readingId: z.string().uuid().optional(),
    note: z.string().trim().min(1).max(500).optional().nullable(),
  })
  .strict();
export type RecordResponsibilityMetricReading = z.infer<typeof recordResponsibilityMetricReadingSchema>;

/** The display forms a bar template's primary metric can take. */
export function primaryDisplaysFor(kind: ResponsibilityMetricKind): readonly ResponsibilityMetricDisplay[] {
  switch (kind) {
    case "percentage":
      return ["percent", "line", "bar", "number"];
    case "yes_no":
      return ["number"];
    case "volume":
    case "range":
      return ["number", "line", "bar"];
  }
}

// ---------------------------------------------------------------------------
// The five visualizations a person sees
// ---------------------------------------------------------------------------

/**
 * Every metric is drawn as one of five visualizations, each named in a word a
 * person would use; nothing else can be shown, and the person never fills in
 * a chart configuration. They map onto the stored display forms and the bar's
 * template: `number` a large value against its target, `percent` a ring
 * toward a target share, `yes_no` a single state (a yes-or-no bar), `trend` a
 * line over time with the target line, `per_week` one bar per week with the
 * target line.
 */
export const RESPONSIBILITY_VISUALIZATIONS = ["number", "percent", "yes_no", "trend", "per_week"] as const;
export type ResponsibilityVisualization = (typeof RESPONSIBILITY_VISUALIZATIONS)[number];

export const RESPONSIBILITY_VISUALIZATION_LABEL: Record<ResponsibilityVisualization, string> = {
  number: "Number",
  percent: "Percent",
  yes_no: "Yes / No",
  trend: "Trend",
  per_week: "Per week",
};

/** What a metric is drawn as, in the person's words. A yes-or-no bar is always Yes / No. */
export function responsibilityVisualizationOf(metric: { display: ResponsibilityMetricDisplay; kind?: ResponsibilityMetricKind | null }): ResponsibilityVisualization {
  if (metric.kind === "yes_no") return "yes_no";
  switch (metric.display) {
    case "number":
      return "number";
    case "percent":
      return "percent";
    case "line":
      return "trend";
    case "bar":
      return "per_week";
  }
}

/** The stored display form a visualization uses (Yes / No is a yes-or-no bar drawn as its answer). */
export function responsibilityVisualizationDisplay(visualization: ResponsibilityVisualization): ResponsibilityMetricDisplay {
  switch (visualization) {
    case "number":
    case "yes_no":
      return "number";
    case "percent":
      return "percent";
    case "trend":
      return "line";
    case "per_week":
      return "bar";
  }
}

/**
 * The display forms a metric's data allows, in the order of the five
 * visualizations. The bar's own metric follows its template (a range shows as
 * a number or a trend with its band; a yes or no only as its answer). A
 * supporting metric that is a share (percent, or a % unit) can be a percent,
 * a trend, bars per week or a number; any other can be a number, a trend or
 * bars per week.
 */
export function responsibilityMetricDisplaysFor(metric: {
  role: "primary" | "supporting";
  kind?: ResponsibilityMetricKind | null;
  display: ResponsibilityMetricDisplay;
  unit?: string | null;
}): ResponsibilityMetricDisplay[] {
  let allowed: readonly ResponsibilityMetricDisplay[];
  if (metric.role === "primary" && metric.kind) {
    allowed = metric.kind === "range" ? ["number", "line"] : primaryDisplaysFor(metric.kind);
  } else {
    const share = metric.display === "percent" || metric.unit?.trim() === "%";
    allowed = share ? ["percent", "line", "bar", "number"] : ["number", "line", "bar"];
  }
  const order = (display: ResponsibilityMetricDisplay) =>
    RESPONSIBILITY_VISUALIZATIONS.indexOf(responsibilityVisualizationOf({ display, kind: metric.role === "primary" ? metric.kind : null }));
  return [...allowed].sort((a, b) => order(a) - order(b));
}

/** The visualizations a person may switch a metric between ("Show as"), its current one always among them. */
export function responsibilityVisualizationsFor(metric: {
  role: "primary" | "supporting";
  kind?: ResponsibilityMetricKind | null;
  display: ResponsibilityMetricDisplay;
  unit?: string | null;
}): ResponsibilityVisualization[] {
  const kind = metric.role === "primary" ? metric.kind ?? null : null;
  const forms = new Set(responsibilityMetricDisplaysFor(metric).map((display) => responsibilityVisualizationOf({ display, kind })));
  forms.add(responsibilityVisualizationOf({ display: metric.display, kind }));
  return RESPONSIBILITY_VISUALIZATIONS.filter((visualization) => forms.has(visualization));
}

/**
 * `PATCH /api/responsibilities/:id/metrics/:metricId` (`metricId` is a
 * supporting metric's id, or `primary`): the owner switches how one metric is
 * drawn, among the forms its data allows. Its readings stay as they are.
 */
export const setResponsibilityMetricDisplaySchema = z
  .object({ display: z.enum(RESPONSIBILITY_METRIC_DISPLAYS) })
  .strict();
export type SetResponsibilityMetricDisplay = z.infer<typeof setResponsibilityMetricDisplaySchema>;

/** Problems with a reading for a supporting metric; null when it is acceptable. */
export function responsibilityMetricReadingIssue(display: ResponsibilityMetricDisplay, value: number | boolean): string | null {
  if (typeof value === "boolean") return "A supporting metric's reading is a number";
  if (display === "percent" && percentIssue(value)) return "A percent reading is a share from 0 to 100";
  return null;
}
