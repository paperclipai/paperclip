import type {
  CreateResponsibility,
  DelegateResponsibility,
  UpdateResponsibility,
  IssueStatus,
  Responsibility,
  ResponsibilityArea,
  ResponsibilityDelegationMode,
  ResponsibilityHealth,
  ResponsibilityMetricDirection,
  ResponsibilityMetricSummary,
  ResponsibilityOverdueProject,
  ResponsibilityRollup,
  ResponsibilityTaskSummary,
  ResponsibilityWithRollup,
  ResponsibilityWorkSignal,
  ResponsibilityWorkSignalTone,
} from "@paperclipai/shared";
import {
  RESPONSIBILITY_BAR_TEMPLATES,
  resolveResponsibilityMetricKind,
  responsibilityBarMissingForActive,
  responsibilityStatusRule,
  type ResponsibilityMetricKind,
} from "@paperclipai/shared";
import { ApiError } from "@/api/client";

/** Display order for status everywhere: what needs you first. */
export const RESPONSIBILITY_HEALTH_ORDER: readonly ResponsibilityHealth[] = ["behind", "at_risk", "on_track", "not_measured"];

export const RESPONSIBILITY_HEALTH_LABEL: Record<ResponsibilityHealth, string> = {
  behind: "Behind",
  at_risk: "At risk",
  on_track: "On track",
  not_measured: "Not measured",
};

/**
 * Status maps onto the shared status hues (blocked red, amber for "needs
 * you", done green, backlog gray) so the vocabulary matches every other
 * status surface.
 */
export const RESPONSIBILITY_HEALTH_STATUS_VAR: Record<ResponsibilityHealth, string> = {
  behind: "--status-task-blocked",
  at_risk: "--status-task-todo",
  on_track: "--status-task-done",
  not_measured: "--status-task-backlog",
};

/** AA-tuned text and icon hues for the same statuses. */
export const RESPONSIBILITY_HEALTH_TEXT_VAR: Record<ResponsibilityHealth, string> = {
  behind: "--status-task-icon-blocked",
  at_risk: "--status-task-icon-todo",
  on_track: "--status-task-icon-done",
  not_measured: "--status-task-icon-backlog",
};

/** Work-summary tones on the same hues: attention is "needs you" amber. */
export const RESPONSIBILITY_SIGNAL_TONE_VAR: Record<ResponsibilityWorkSignalTone, string> = {
  attention: "--status-task-todo",
  neutral: "--status-task-backlog",
  good: "--status-task-done",
};

/**
 * The lines that need attention under a responsibility (late projects,
 * blocked tasks, failed routines, a stale metric), from its work summary.
 */
export function responsibilityAttentionReasons(rollup: Pick<ResponsibilityRollup, "workSummary">): string[] {
  return rollup.workSummary.filter((signal) => signal.tone === "attention").map((signal) => signal.text);
}

/**
 * The few signals a home-page row shows: attention first (the server already
 * orders by tone), at most `limit`.
 */
export function topWorkSignals(rollup: Pick<ResponsibilityRollup, "workSummary">, limit = 2): ResponsibilityWorkSignal[] {
  return rollup.workSummary.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Metric formatting
// ---------------------------------------------------------------------------

const PREFIX_UNITS = new Set(["$", "€", "£", "¥"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function formatPlainNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * One metric value with its unit: currency symbols go in front ("$12,000"),
 * "%" sticks to the number ("45%"), and a word follows it ("3 days").
 * Millions and up are shortened ("$1.2M").
 */
export function formatMetricValue(value: number, unit: string | null | undefined): string {
  const trimmed = unit?.trim() ?? "";
  const number = formatPlainNumber(Math.abs(value));
  const sign = value < 0 ? "-" : "";
  if (!trimmed) return `${sign}${number}`;
  if (PREFIX_UNITS.has(trimmed)) return `${sign}${trimmed}${number}`;
  if (trimmed === "%") return `${sign}${number}%`;
  return `${sign}${number} ${trimmed}`;
}

/** How a reading is drawn: a fill toward the target, a marker against a range, or nothing for a yes or no. */
export type MetricVisual =
  | { kind: "fill"; progress: number | null }
  /** Positions are shares (0 to 1) of a track that shows the range with room either side. */
  | { kind: "range"; low: number; high: number; marker: number | null }
  | { kind: "yes_no"; value: boolean | null };

export interface MetricReading {
  /** The latest reading with its unit ("Yes" or "No" for a yes-or-no bar), or null before the first one. */
  current: string | null;
  /** The target with its unit ("12–24 months" for a range, "yes" for a yes or no), or null when none is set. */
  target: string | null;
  /** What follows the reading at a glance: "of 20", "vs. at most 2 days", "range 12–24 months", or "target 20" before a reading. */
  targetLabel: string;
  /** How far toward the bar, 0 to 1 (1 = met); null without a reading and a complete bar. */
  progress: number | null;
  /** One line for screen readers and compact places: "9 of 20 investors contacted". */
  summary: string;
  visual: MetricVisual;
}

/** "12–24", "12–24 months", "$10–$20", "40%–60%": a word unit is said once, after the range. */
export function formatMetricRange(low: number, high: number, unit: string | null | undefined): string {
  const trimmed = unit?.trim() ?? "";
  const word = /[A-Za-z]/.test(trimmed);
  if (word) return `${formatMetricValue(low, null)}–${formatMetricValue(high, trimmed)}`;
  return `${formatMetricValue(low, trimmed)}–${formatMetricValue(high, trimmed)}`;
}

type ReadableMetric = Pick<ResponsibilityMetricSummary, "name" | "unit" | "target" | "current" | "direction" | "attainment">
  & Partial<Pick<ResponsibilityMetricSummary, "kind" | "low" | "high">>;

/**
 * The metric as it reads at a glance, for every bar template: the number
 * against its target, a yes or no, or a value against its range. Every view
 * of a responsibility reads its metric through this one helper.
 */
export function describeMetricReading(metric: ReadableMetric): MetricReading {
  const kind = metric.kind ?? resolveResponsibilityMetricKind(null, metric.unit);
  const name = metric.name.trim();
  const lowerName = name.charAt(0).toLowerCase() + name.slice(1);
  const progress = metric.attainment === null ? null : Math.min(1, Math.max(0, metric.attainment));

  if (kind === "yes_no") {
    const value = metric.current === null ? null : metric.current >= 1;
    const current = value === null ? null : value ? "Yes" : "No";
    return {
      current,
      target: "yes",
      targetLabel: value === true ? "as the bar asks" : "the bar is yes",
      progress,
      summary: `${name}: ${current ? current.toLowerCase() : "no answer yet"}`,
      visual: { kind: "yes_no", value },
    };
  }

  if (kind === "range") {
    const low = metric.low ?? null;
    const high = metric.high ?? null;
    const current = metric.current === null ? null : formatMetricValue(metric.current, metric.unit);
    if (low === null || high === null || !(high > low)) {
      return {
        current, target: null, targetLabel: "no range set", progress: null,
        summary: `${name}: ${current ?? "no reading yet"}, no range set`,
        visual: { kind: "fill", progress: null },
      };
    }
    const range = formatMetricRange(low, high, metric.unit);
    // The track shows half the range's width either side of it, widened to fit the reading.
    const pad = (high - low) / 2;
    const start = Math.min(low - pad, metric.current ?? low);
    const end = Math.max(high + pad, metric.current ?? high);
    const at = (value: number) => (value - start) / (end - start);
    return {
      current,
      target: range,
      targetLabel: `range ${range}`,
      progress,
      summary: `${name}: ${current ?? "no reading yet"}, range ${range}`,
      visual: { kind: "range", low: at(low), high: at(high), marker: metric.current === null ? null : at(metric.current) },
    };
  }

  const current = metric.current === null ? null : formatMetricValue(metric.current, metric.unit);
  const target = metric.target === null ? null : formatMetricValue(metric.target, metric.unit);
  const atMost = metric.direction === "at_most";
  const visual: MetricVisual = { kind: "fill", progress };

  if (current === null) {
    const targetLabel = target ? (atMost ? `target at most ${target}` : `target ${target}`) : "no target set";
    return { current: null, target, targetLabel, progress, summary: `${name}: no reading yet, ${targetLabel}`, visual };
  }
  if (target === null) {
    return { current, target, targetLabel: "no target set", progress, summary: `${name}: ${current}, no target set`, visual };
  }
  if (atMost) {
    const targetLabel = `vs. at most ${target}`;
    return { current, target, targetLabel, progress, summary: `${name}: ${current}, target at most ${target}`, visual };
  }
  return { current, target, targetLabel: `of ${target}`, progress, summary: `${current} of ${target} ${lowerName}`, visual };
}

/** Whole days between two instants, never negative. */
export function daysBetween(earlier: Date | string, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - new Date(earlier).getTime()) / DAY_MS));
}

/** When a reading was taken, as a phrase: "today", "yesterday", "3 days ago", "on Oct 2". */
export function describeReadingAge(updatedAt: Date | string, now: Date): string {
  const days = daysBetween(updatedAt, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const date = new Date(updatedAt);
  return `on ${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  })}`;
}

/** The stale flag's words: "Not updated in 16 days". */
export function describeStale(updatedAt: Date | string, now: Date): string {
  const days = daysBetween(updatedAt, now);
  return `Not updated in ${days} ${days === 1 ? "day" : "days"}`;
}

/** How close (ms) an activity entry must be to `metricUpdatedAt` to be the same reading. */
const READING_MATCH_MS = 60_000;

/**
 * Who reported the current reading, from the responsibility's activity: the
 * newest `responsibility.metric_updated` entry, when it matches the reading's
 * time. Null when unknown (no entry, or it is for an older reading).
 */
export function lastReadingActor(
  events: readonly { action: string; actorType: string; actorId: string; createdAt: Date | string }[],
  metricUpdatedAt: Date | string | null,
): { actorType: string; actorId: string } | null {
  if (!metricUpdatedAt) return null;
  const at = new Date(metricUpdatedAt).getTime();
  let newest: (typeof events)[number] | null = null;
  for (const event of events) {
    if (event.action !== "responsibility.metric_updated") continue;
    if (!newest || new Date(event.createdAt).getTime() > new Date(newest.createdAt).getTime()) newest = event;
  }
  if (!newest || Math.abs(new Date(newest.createdAt).getTime() - at) > READING_MATCH_MS) return null;
  return { actorType: newest.actorType, actorId: newest.actorId };
}

export const METRIC_DIRECTION_OPTIONS: ReadonlyArray<{ value: ResponsibilityMetricDirection; label: string }> = [
  { value: "at_least", label: "At least (higher is better)" },
  { value: "at_most", label: "At most (lower is better)" },
];

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export interface AreaGroup<T> {
  /** Null for the group of items filed under no area. */
  area: Pick<ResponsibilityArea, "id" | "title" | "status"> | null;
  items: T[];
}

const HEALTH_RANK = new Map(RESPONSIBILITY_HEALTH_ORDER.map((health, index) => [health, index]));

/** Behind first, then at risk, on track and not measured; let-go ones last. Stable otherwise. */
export function sortByStatus<T extends Pick<ResponsibilityWithRollup, "status" | "rollup">>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      Number(a.item.status === "let_go") - Number(b.item.status === "let_go")
      || HEALTH_RANK.get(a.item.rollup.health)! - HEALTH_RANK.get(b.item.rollup.health)!
      || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Items grouped under their areas, in the areas' own order. Only areas that
 * hold an item appear, plus any listed in `keepEmpty` (an area the person
 * just added). Items with no area, or an area not in the list, form one
 * final group with `area: null`. Items keep their order within a group.
 */
export function groupByArea<T extends { areaId: string | null }>(
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[],
  items: readonly T[],
  keepEmpty: ReadonlySet<string> = new Set(),
): AreaGroup<T>[] {
  const known = new Set(areas.map((area) => area.id));
  const byArea = new Map<string, T[]>();
  const loose: T[] = [];
  for (const item of items) {
    if (item.areaId && known.has(item.areaId)) {
      const list = byArea.get(item.areaId) ?? [];
      list.push(item);
      byArea.set(item.areaId, list);
    } else {
      loose.push(item);
    }
  }
  const groups: AreaGroup<T>[] = [];
  for (const area of areas) {
    const list = byArea.get(area.id);
    if (list || keepEmpty.has(area.id)) groups.push({ area: { id: area.id, title: area.title, status: area.status }, items: list ?? [] });
  }
  if (loose.length > 0) groups.push({ area: null, items: loose });
  return groups;
}

/** Active areas where none of `items` sits (and not already shown): somewhere else the company cares about. */
export function otherActiveAreas<A extends Pick<ResponsibilityArea, "id" | "status">>(
  areas: readonly A[],
  items: readonly { areaId: string | null }[],
  shown: ReadonlySet<string> = new Set(),
): A[] {
  const used = new Set(items.map((item) => item.areaId).filter((id): id is string => id !== null));
  return areas.filter((area) => area.status === "active" && !used.has(area.id) && !shown.has(area.id));
}

// ---------------------------------------------------------------------------
// What needs you, and what runs without you
// ---------------------------------------------------------------------------

export interface AttentionItem {
  text: string;
  signal: ResponsibilityWorkSignal | null;
}

/**
 * Why a responsibility needs its owner: its attention signals, or, when it is
 * behind or at risk with none, its status sentence. Empty when it needs nothing.
 */
export function attentionItems(responsibility: Pick<ResponsibilityWithRollup, "rollup">): AttentionItem[] {
  const signals = responsibility.rollup.workSummary.filter((signal) => signal.tone === "attention");
  if (signals.length > 0) return signals.map((signal) => ({ text: signal.text, signal }));
  const { health } = responsibility.rollup;
  if (health === "behind" || health === "at_risk") return [{ text: responsibility.rollup.statusSentence, signal: null }];
  return [];
}

const RUNNING_KINDS = new Set<ResponsibilityWorkSignal["kind"]>(["tasks_open_agent", "routine_active", "tasks_completed_recently"]);

/** The signals that show work moving without the owner: agent tasks, active routines, recent completions. */
export function runningSignals(responsibility: Pick<ResponsibilityWithRollup, "rollup">): ResponsibilityWorkSignal[] {
  return responsibility.rollup.workSummary.filter((signal) => RUNNING_KINDS.has(signal.kind));
}

// ---------------------------------------------------------------------------
// Handing items to agents, and who is working
// ---------------------------------------------------------------------------

/** One project, task or routine that can be given to an agent. */
export interface GivableItem {
  kind: "project" | "task" | "routine";
  id: string;
  label: string;
  /** The agent that has it now (a project's lead), if any. */
  currentAgentId: string | null;
}

/** The project, task or routine a signal points at, as something to give to an agent; null otherwise. */
export function givableFromSignal(signal: Pick<ResponsibilityWorkSignal, "refType" | "refId" | "text">): GivableItem | null {
  if (!signal.refId) return null;
  const kind = signal.refType === "issue" ? "task" : signal.refType === "project" ? "project" : signal.refType === "routine" ? "routine" : null;
  return kind ? { kind, id: signal.refId, label: signal.text, currentAgentId: null } : null;
}

/** Agents with open tasks under a responsibility, from its work summary (the overview carries no item lists). */
export function agentIdsFromSignals(rollup: Pick<ResponsibilityRollup, "workSummary">): string[] {
  const ids: string[] = [];
  for (const signal of rollup.workSummary) {
    if (signal.refType === "agent" && signal.refId && !ids.includes(signal.refId)) ids.push(signal.refId);
  }
  return ids;
}

export interface AgentAtWork {
  agentId: string;
  tasks: number;
  routines: number;
  projects: number;
}

/**
 * The agents working under a responsibility, from what is filed under it:
 * assignees of its open tasks and its routines that are not archived, and
 * its projects' leads. Most involved first, then in first-seen order.
 */
export function agentsWorkingUnder(detail: {
  tasks: readonly Pick<ResponsibilityTaskSummary, "assigneeAgentId" | "status">[];
  routines: readonly { assigneeAgentId: string | null; status: string }[];
  projects: readonly { leadAgentId: string | null; status: string; archivedAt: Date | string | null }[];
}): AgentAtWork[] {
  const byAgent = new Map<string, AgentAtWork>();
  const entry = (agentId: string) => {
    const existing = byAgent.get(agentId);
    if (existing) return existing;
    const created = { agentId, tasks: 0, routines: 0, projects: 0 };
    byAgent.set(agentId, created);
    return created;
  };
  for (const task of detail.tasks) if (task.assigneeAgentId && !isTerminalTaskStatus(task.status)) entry(task.assigneeAgentId).tasks += 1;
  for (const routine of detail.routines) if (routine.assigneeAgentId && routine.status !== "archived") entry(routine.assigneeAgentId).routines += 1;
  for (const project of detail.projects) {
    const finished = project.archivedAt || project.status === "completed" || project.status === "cancelled";
    if (project.leadAgentId && !finished) entry(project.leadAgentId).projects += 1;
  }
  return [...byAgent.values()]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.tasks + b.item.routines + b.item.projects) - (a.item.tasks + a.item.routines + a.item.projects) || a.index - b.index)
    .map(({ item }) => item);
}

/** "2 tasks, 1 routine" */
export function describeAgentWork(work: Pick<AgentAtWork, "tasks" | "routines" | "projects">): string {
  const parts: string[] = [];
  if (work.tasks) parts.push(`${work.tasks} ${work.tasks === 1 ? "task" : "tasks"}`);
  if (work.routines) parts.push(`${work.routines} ${work.routines === 1 ? "routine" : "routines"}`);
  if (work.projects) parts.push(`leads ${work.projects} ${work.projects === 1 ? "project" : "projects"}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// The bar: the sentence, the metric, the target
// ---------------------------------------------------------------------------

export type BarField = "standard" | "metricName" | "metricTarget" | "metricCurrent" | "metricUnit" | "metricLow" | "metricHigh";

export const BAR_FIELD_LABEL: Record<BarField, string> = {
  standard: "the bar",
  metricName: "what you measure",
  metricTarget: "a target",
  metricCurrent: "the current reading",
  metricUnit: "the unit",
  metricLow: "a low bound",
  metricHigh: "a high bound",
};

/** The bar templates in the order the form offers them, with their person-facing names. */
export const METRIC_KIND_OPTIONS: ReadonlyArray<{ value: ResponsibilityMetricKind; label: string; summary: string }> =
  (["volume", "percentage", "yes_no", "range"] as const).map((kind) => ({
    value: kind,
    label: RESPONSIBILITY_BAR_TEMPLATES[kind].label,
    summary: RESPONSIBILITY_BAR_TEMPLATES[kind].summary,
  }));

/** The bar as the form holds it: text, with numbers still as typed. A yes-or-no reading is "yes", "no" or "". */
export interface BarDraft {
  metricKind: ResponsibilityMetricKind;
  standard: string;
  metricName: string;
  metricDirection: ResponsibilityMetricDirection;
  metricTarget: string;
  metricUnit: string;
  metricLow: string;
  metricHigh: string;
  metricCurrent: string;
}

function numberText(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function barDraftFrom(
  responsibility?: Partial<Pick<Responsibility,
    "standard" | "metricName" | "metricDirection" | "metricTarget" | "metricUnit" | "metricCurrent" | "metricKind" | "metricLow" | "metricHigh">> | null,
): BarDraft {
  const metricKind = resolveResponsibilityMetricKind(responsibility?.metricKind, responsibility?.metricUnit);
  const current = responsibility?.metricCurrent;
  return {
    metricKind,
    standard: responsibility?.standard ?? "",
    metricName: responsibility?.metricName ?? "",
    metricDirection: responsibility?.metricDirection ?? "at_least",
    metricTarget: numberText(responsibility?.metricTarget),
    metricUnit: metricKind === "percentage" ? "" : responsibility?.metricUnit ?? "",
    metricLow: numberText(responsibility?.metricLow),
    metricHigh: numberText(responsibility?.metricHigh),
    metricCurrent: metricKind === "yes_no"
      ? current === null || current === undefined ? "" : current >= 1 ? "yes" : "no"
      : numberText(current),
  };
}

/** A typed number: blank is null, "1,200" is 1200, anything else that is not a finite number is "invalid". */
export function parseMetricNumber(text: string): number | null | "invalid" {
  const cleaned = text.replace(/[,\s]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : "invalid";
}

export interface ParsedBar {
  standard: string;
  metricName: string;
  metricKind: ResponsibilityMetricKind;
  /** Volume and percentage only. */
  metricDirection: ResponsibilityMetricDirection | null;
  metricTarget: number | null;
  metricUnit: string | null;
  metricLow: number | null;
  metricHigh: number | null;
  /** A number, or true/false for a yes or no. */
  metricCurrent: number | boolean | null;
}

export type BarValidation =
  | { ok: true; value: ParsedBar }
  /** `problems` says what is wrong with a field beyond "Enter a number". */
  | { ok: false; missing: BarField[]; invalid: BarField[]; problems: Partial<Record<BarField, string>> };

/**
 * Check a draft against its template: the bar and what is measured are always
 * required, then a target (volume, percentage from 0 to 100) or a low and a
 * high bound (range); numbers must be numbers.
 */
export function validateBarDraft(draft: BarDraft): BarValidation {
  const missing: BarField[] = [];
  const invalid: BarField[] = [];
  const problems: Partial<Record<BarField, string>> = {};
  const kind = draft.metricKind;
  const uses = (field: "metricTarget" | "metricLow" | "metricHigh" | "metricUnit" | "metricDirection") =>
    RESPONSIBILITY_BAR_TEMPLATES[kind].fields.includes(field);
  const standard = draft.standard.trim();
  const metricName = draft.metricName.trim();
  if (!standard) missing.push("standard");
  if (!metricName) missing.push("metricName");
  const number = (field: "metricTarget" | "metricLow" | "metricHigh") => {
    if (!uses(field)) return null;
    const value = parseMetricNumber(draft[field]);
    if (value === null) missing.push(field);
    else if (value === "invalid") invalid.push(field);
    return typeof value === "number" ? value : null;
  };
  const target = number("metricTarget");
  const low = number("metricLow");
  const high = number("metricHigh");
  if (kind === "percentage" && target !== null && (target < 0 || target > 100)) {
    invalid.push("metricTarget");
    problems.metricTarget = "A share from 0 to 100";
  }
  if (low !== null && high !== null && !(high > low)) {
    invalid.push("metricHigh");
    problems.metricHigh = "Above the low bound";
  }
  let current: number | boolean | null = null;
  if (kind === "yes_no") {
    current = draft.metricCurrent === "yes" ? true : draft.metricCurrent === "no" ? false : null;
  } else {
    const parsed = parseMetricNumber(draft.metricCurrent);
    if (parsed === "invalid") invalid.push("metricCurrent");
    else if (kind === "percentage" && parsed !== null && (parsed < 0 || parsed > 100)) {
      invalid.push("metricCurrent");
      problems.metricCurrent = "A share from 0 to 100";
    } else current = parsed;
  }
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, invalid, problems };
  return {
    ok: true,
    value: {
      standard,
      metricName,
      metricKind: kind,
      metricDirection: uses("metricDirection") ? draft.metricDirection : null,
      metricTarget: target,
      metricUnit: kind === "percentage" ? "%" : uses("metricUnit") ? draft.metricUnit.trim() || null : null,
      metricLow: low,
      metricHigh: high,
      metricCurrent: current,
    },
  };
}

/** How status will be read for a draft ("On track at 90% or more; at risk from 68%"), or null while it is incomplete. */
export function describeDraftStatusRule(draft: BarDraft): string | null {
  const checked = validateBarDraft({ ...draft, standard: draft.standard || "-", metricName: draft.metricName || "Value", metricCurrent: "" });
  if (!checked.ok) return null;
  const bar = checked.value;
  return responsibilityStatusRule({
    kind: bar.metricKind,
    name: bar.metricName,
    unit: bar.metricUnit,
    direction: bar.metricDirection,
    target: bar.metricTarget,
    low: bar.metricLow,
    high: bar.metricHigh,
  });
}

/** The create request for a new responsibility: blank optional fields and the template's unused inputs are left out. */
export function buildCreateResponsibilityPayload(input: {
  title: string;
  bar: ParsedBar;
  areaId: string | null;
}): CreateResponsibility {
  const { bar } = input;
  return {
    title: input.title.trim(),
    standard: bar.standard,
    metricKind: bar.metricKind,
    metricName: bar.metricName,
    ...(bar.metricTarget !== null ? { metricTarget: bar.metricTarget } : {}),
    ...(bar.metricDirection ? { metricDirection: bar.metricDirection } : {}),
    ...(bar.metricLow !== null ? { metricLow: bar.metricLow } : {}),
    ...(bar.metricHigh !== null ? { metricHigh: bar.metricHigh } : {}),
    ...(bar.metricUnit ? { metricUnit: bar.metricUnit } : {}),
    ...(bar.metricCurrent !== null ? { metricCurrent: bar.metricCurrent } : {}),
    ...(input.areaId ? { areaId: input.areaId } : {}),
  };
}

/** The bar as an update: the template and every input, the unused ones cleared. The current reading is left out. */
export function buildBarUpdate(bar: ParsedBar): UpdateResponsibility {
  return {
    standard: bar.standard,
    metricKind: bar.metricKind,
    metricName: bar.metricName,
    metricTarget: bar.metricTarget,
    metricDirection: bar.metricDirection,
    metricUnit: bar.metricUnit,
    metricLow: bar.metricLow,
    metricHigh: bar.metricHigh,
  };
}

/**
 * The bar fields, by form name, a responsibility still needs before its owner
 * can confirm it: none when it has no metric at all (it is confirmed as not
 * measured, and its bar is set later), and the rest of the bar when its
 * metric is half-filled.
 */
export function missingBarFields(row: Pick<Responsibility, "standard" | "metricName" | "metricTarget">
  & Partial<Pick<Responsibility, "metricKind" | "metricUnit" | "metricLow" | "metricHigh" | "metricCurrent">>): BarField[] {
  const missing = responsibilityBarMissingForActive(row, { barOptional: true });
  return (["standard", "metricName", "metricTarget", "metricLow", "metricHigh"] as const).filter((field) => missing.includes(field));
}

/** Whether a bar form leaves the metric blank: nothing measured, no numbers, no reading. The sentence may be filled. */
export function isMetricDraftBlank(draft: BarDraft): boolean {
  return [draft.metricName, draft.metricTarget, draft.metricUnit, draft.metricLow, draft.metricHigh, draft.metricCurrent]
    .every((value) => !value.trim());
}

/** "the bar, what you measure and a target" */
export function joinFieldLabels(fields: readonly BarField[]): string {
  const labels = fields.map((field) => BAR_FIELD_LABEL[field]);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/**
 * The fields a refused activation named (422 with `details.missing`), mapped
 * to the form's fields. Empty for any other error.
 */
export function missingFieldsFromError(error: unknown): BarField[] {
  if (!(error instanceof ApiError) || error.status !== 422) return [];
  const body = error.body as { details?: { missing?: unknown } } | null;
  const missing = body?.details?.missing;
  if (!Array.isArray(missing)) return [];
  const known: BarField[] = ["standard", "metricName", "metricTarget", "metricLow", "metricHigh"];
  return known.filter((field) => missing.includes(field));
}

export interface DelegationModeOption {
  value: ResponsibilityDelegationMode;
  title: string;
  description: string;
}

/** The ways to hand a new task to an agent, with what each one means for you. */
export const RESPONSIBILITY_DELEGATION_MODE_OPTIONS: readonly DelegationModeOption[] = [
  {
    value: "plan_with_me",
    title: "Plan it with me",
    description: "The agent proposes a plan and waits for your approval before doing the work.",
  },
  {
    value: "prepare_i_decide",
    title: "Prepare it, I decide",
    description: "The agent does the groundwork and brings the decision back to you.",
  },
  {
    value: "handle_and_tell_me",
    title: "Handle it and tell me",
    description: "The agent does it end to end and tells you what it did.",
  },
  // "own_from_now_on" is left out: a person gives an agent a task, a routine
  // or a project, never a whole responsibility.
];

export const DEFAULT_DELEGATION_MODE: ResponsibilityDelegationMode = "prepare_i_decide";

/** The delegate request body, with blank optional fields left out. */
export function buildDelegationPayload(input: {
  title: string;
  instructions?: string | null;
  assigneeAgentId: string;
  mode: ResponsibilityDelegationMode;
  projectId?: string | null;
}): DelegateResponsibility {
  const payload: DelegateResponsibility = {
    title: input.title.trim(),
    assigneeAgentId: input.assigneeAgentId,
    mode: input.mode,
  };
  const instructions = input.instructions?.trim();
  if (instructions) payload.instructions = instructions;
  if (input.projectId) payload.projectId = input.projectId;
  return payload;
}

/**
 * What "Give to an agent" starts with for one reason a responsibility needs you.
 *
 * A reason is a statement ("Finish the pitch deck is 12 days past its target
 * date"), and a task title is an instruction. A late project becomes an
 * instruction about that project, filed in it; any other reason is passed
 * through for the person to edit.
 */
export function delegationPrefillForReason(
  reason: string,
  overdueProjects: readonly ResponsibilityOverdueProject[],
): { title: string; projectId: string | null } {
  const project = overdueProjects.find((candidate) => reason.startsWith(`${candidate.name} is `));
  if (project) return { title: `Get “${project.name}” back on schedule`, projectId: project.id };
  return { title: reason, projectId: null };
}

/** Agent-run share of open work: `agentTasks` of `openTasks`, as a whole percentage. */
export function agentPoweredShare(agentTasks: number, openTasks: number): { percent: number; label: string } {
  if (openTasks <= 0) return { percent: 0, label: "No open tasks" };
  const percent = Math.round((Math.min(agentTasks, openTasks) / openTasks) * 100);
  return { percent, label: `${agentTasks} of ${openTasks}` };
}

/** Local calendar date as `YYYY-MM-DD`, to compare with target dates. */
export function localDateKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The next target date for display. Target dates are calendar dates, so they
 * are formatted without a time zone shift; `late` once the date has passed.
 */
export function describeNextDue(nextDueAt: string | null, now: Date): { label: string; late: boolean } | null {
  if (!nextDueAt) return null;
  const [year, month, day] = nextDueAt.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  const label = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return { label, late: nextDueAt < localDateKey(now) };
}

const TERMINAL_TASK_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

export function isTerminalTaskStatus(status: IssueStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

/** Open tasks (blocked first, keeping server order otherwise) and finished ones. */
export function splitResponsibilityTasks(tasks: readonly ResponsibilityTaskSummary[]): {
  open: ResponsibilityTaskSummary[];
  blocked: number;
  done: ResponsibilityTaskSummary[];
} {
  const blocked: ResponsibilityTaskSummary[] = [];
  const open: ResponsibilityTaskSummary[] = [];
  const done: ResponsibilityTaskSummary[] = [];
  for (const task of tasks) {
    if (isTerminalTaskStatus(task.status)) done.push(task);
    else if (task.status === "blocked") blocked.push(task);
    else open.push(task);
  }
  return { open: [...blocked, ...open], blocked: blocked.length, done };
}

/**
 * Where the responsibilities came from, when an agent drafted them during
 * onboarding: the agent and the most recent confirmation. Null when none did.
 */
export function onboardingProvenance(
  responsibilities: readonly ResponsibilityWithRollup[],
): { agentId: string | null; confirmedAt: Date | null } | null {
  let agentId: string | null = null;
  let confirmedAt: Date | null = null;
  let found = false;
  for (const responsibility of responsibilities) {
    if (responsibility.source !== "onboarding") continue;
    found = true;
    agentId ??= responsibility.proposedByAgentId;
    if (responsibility.confirmedAt) {
      const at = new Date(responsibility.confirmedAt);
      if (!confirmedAt || at > confirmedAt) confirmedAt = at;
    }
  }
  return found ? { agentId, confirmedAt } : null;
}

/** Path to a responsibility (company-relative; the router adds the prefix). */
export function responsibilityPath(id: string): string {
  return `/responsibilities/${encodeURIComponent(id)}`;
}

export function routinePath(id: string): string {
  return `/routines/${encodeURIComponent(id)}`;
}

/**
 * Where a work-summary signal leads: its project, task, routine or agent.
 * Null for an aggregate line, a person, or the responsibility itself (the
 * stale-reading line, which the responsibility page points at its bar).
 */
export function signalHref(signal: Pick<ResponsibilityWorkSignal, "refType" | "refId">): string | null {
  if (!signal.refId) return null;
  switch (signal.refType) {
    case "project":
      return `/projects/${encodeURIComponent(signal.refId)}`;
    case "issue":
      return `/issues/${encodeURIComponent(signal.refId)}`;
    case "routine":
      return routinePath(signal.refId);
    case "agent":
      return `/agents/${encodeURIComponent(signal.refId)}`;
    default:
      return null;
  }
}
