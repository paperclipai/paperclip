import {
  RESPONSIBILITY_DUE_SOON_DAYS,
  RESPONSIBILITY_RECENTLY_COMPLETED_DAYS,
} from "@paperclipai/shared";
import type {
  ResponsibilityArea,
  ResponsibilityDetail,
  ResponsibilityHealth,
  ResponsibilityMetricSummary,
  ResponsibilityOverview,
  ResponsibilityProjectSummary,
  ResponsibilityRoutineSummary,
  ResponsibilityTaskSummary,
  ResponsibilityWithRollup,
  ResponsibilityWorkSignal,
} from "@paperclipai/shared";
import {
  daysBetween,
  describeMetricReading,
  describeNextDue,
  describeReadingAge,
  formatMetricRange,
  formatMetricValue,
  groupByArea,
  isTerminalTaskStatus,
  localDateKey,
  RESPONSIBILITY_HEALTH_LABEL,
  routinePath,
  sortByStatus,
  type AreaGroup,
} from "./responsibilities";
import { issueUrl, projectUrl } from "./utils";

/**
 * Derivations for the simpler views of the Dashboard and the responsibility
 * page (experimental, `enableResponsibilities`): the overall status, the
 * per-area share on track, the exception counts, and one ordered list of the
 * work under a responsibility. Pure, so each view stays a plain renderer.
 */

// ---------------------------------------------------------------------------
// Which view, and remembering it
// ---------------------------------------------------------------------------

export interface ViewOption<T extends string> {
  value: T;
  label: string;
}

export type DashboardView = "full" | "outline" | "outline_v2" | "board" | "exceptions" | "automation" | "agent_status";
export type ResponsibilityPageView = "full" | "scorecard" | "moving" | "one_screen" | "one_screen_v2";

export const DASHBOARD_VIEW_OPTIONS: readonly ViewOption<DashboardView>[] = [
  { value: "full", label: "Full" },
  { value: "outline", label: "Outline" },
  { value: "outline_v2", label: "Outline v2" },
  { value: "board", label: "Board" },
  { value: "exceptions", label: "Exceptions" },
  { value: "automation", label: "Automation" },
  { value: "agent_status", label: "Agent status" },
];

export const RESPONSIBILITY_PAGE_VIEW_OPTIONS: readonly ViewOption<ResponsibilityPageView>[] = [
  { value: "full", label: "Full" },
  { value: "scorecard", label: "Scorecard" },
  { value: "moving", label: "What's moving" },
  { value: "one_screen", label: "One screen" },
  { value: "one_screen_v2", label: "One screen v2" },
];

export const DASHBOARD_VIEW_STORAGE_KEY = "paperclip:responsibilities:dashboard-view";
export const RESPONSIBILITY_PAGE_VIEW_STORAGE_KEY = "paperclip:responsibilities:page-view";

/** What the Dashboard opens on without a stored choice: the new dashboard the experimental setting turns on. */
export const DASHBOARD_DEFAULT_VIEW: DashboardView = "outline_v2";
/** What a responsibility page opens on without a stored choice: the page that goes with the new dashboard. */
export const RESPONSIBILITY_PAGE_DEFAULT_VIEW: ResponsibilityPageView = "one_screen_v2";

/**
 * The stored choice when it is one of `options`; otherwise `fallback` (or the
 * first option). Never throws.
 */
export function readStoredView<T extends string>(key: string, options: readonly ViewOption<T>[], fallbackView?: T): T {
  const fallback = fallbackView && options.some((option) => option.value === fallbackView) ? fallbackView : options[0]!.value;
  try {
    const stored = globalThis.localStorage?.getItem(key);
    return options.some((option) => option.value === stored) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The view a `?view=<value>` query names, when it is one of `options`; null otherwise. */
export function viewFromSearch<T extends string>(search: string, options: readonly ViewOption<T>[]): T | null {
  const requested = new URLSearchParams(search).get("view");
  return options.some((option) => option.value === requested) ? (requested as T) : null;
}

/** Remembers the choice when storage is available; silently does nothing otherwise. */
export function writeStoredView(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the choice lasts for this visit only.
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

// ---------------------------------------------------------------------------
// The overall status
// ---------------------------------------------------------------------------

export interface OverallStanding {
  health: ResponsibilityHealth;
  /** One or two plain sentences built from the counts. */
  sentence: string;
  /** Active responsibilities counted. */
  total: number;
}

/**
 * Where everything you own stands, from the counts of active responsibilities
 * by status: behind if any is behind; otherwise at risk if more are at risk
 * than on track; otherwise on track if any is; otherwise not measured.
 */
export function overallStanding(counts: Record<ResponsibilityHealth, number>): OverallStanding {
  const { behind, at_risk: atRisk, on_track: onTrack, not_measured: notMeasured } = counts;
  const total = behind + atRisk + onTrack + notMeasured;
  const health: ResponsibilityHealth =
    behind > 0 ? "behind" : atRisk > onTrack ? "at_risk" : onTrack > 0 ? "on_track" : "not_measured";

  let sentence: string;
  if (total === 0) {
    sentence = "You do not own any responsibilities yet.";
  } else if (behind > 0) {
    const lead = `${count(behind, "responsibility", "responsibilities")} ${isAre(behind)} behind`;
    sentence = atRisk > 0 ? `${lead} and ${atRisk} ${isAre(atRisk)} at risk.` : `${lead}.`;
  } else if (atRisk > 0) {
    sentence = `Nothing is behind. ${count(atRisk, "responsibility", "responsibilities")} ${isAre(atRisk)} at risk.`;
  } else if (onTrack > 0) {
    sentence = notMeasured === 0
      ? "Everything you own is on track."
      : `Nothing is behind or at risk. ${count(notMeasured, "responsibility", "responsibilities")} ${isAre(notMeasured)} not measured yet.`;
  } else {
    sentence = "Nothing you own is measured yet.";
  }
  return { health, sentence, total };
}

// ---------------------------------------------------------------------------
// The Dashboard
// ---------------------------------------------------------------------------

/** Responsibilities the person owns now: the overview can carry let-go ones too. */
export function activeResponsibilities(responsibilities: readonly ResponsibilityWithRollup[]): ResponsibilityWithRollup[] {
  return responsibilities.filter((item) => item.status === "active");
}

/** "67% on track": the share of `total` that is on track; null with nothing to count. */
export function onTrackShare(onTrack: number, total: number): { percent: number; label: string } | null {
  if (total <= 0) return null;
  const percent = Math.round((Math.max(0, Math.min(onTrack, total)) / total) * 100);
  return { percent, label: `${percent}% on track` };
}

export interface OutlineAreaGroup extends AreaGroup<ResponsibilityWithRollup> {
  /** "3 responsibilities you own". */
  ownedLabel: string;
  /** Share of the group's active responsibilities on track; null when it holds none. */
  share: { percent: number; label: string } | null;
}

/**
 * The Outline's areas: each area holding an active responsibility (plus any
 * just added), with what is under it behind first, and the share on track.
 * Responsibilities filed under no area form a last group.
 */
export function outlineAreaGroups(
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[],
  responsibilities: readonly ResponsibilityWithRollup[],
  keepEmpty: ReadonlySet<string> = new Set(),
): OutlineAreaGroup[] {
  return groupByArea(areas, sortByStatus(activeResponsibilities(responsibilities)), keepEmpty).map((group) => ({
    ...group,
    ownedLabel: `${count(group.items.length, "responsibility", "responsibilities")} you own`,
    share: onTrackShare(group.items.filter((item) => item.rollup.health === "on_track").length, group.items.length),
  }));
}

export interface BoardAreaRow extends OutlineAreaGroup {
  /** The area's responsibilities in each status column, in their order within the area. */
  byHealth: Record<ResponsibilityHealth, ResponsibilityWithRollup[]>;
}

/**
 * The Board's rows: the Outline's area groups (count and share on track),
 * each split into the four status columns.
 */
export function boardAreaRows(
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[],
  responsibilities: readonly ResponsibilityWithRollup[],
): BoardAreaRow[] {
  return outlineAreaGroups(areas, responsibilities).map((group) => {
    const byHealth: Record<ResponsibilityHealth, ResponsibilityWithRollup[]> = { behind: [], at_risk: [], on_track: [], not_measured: [] };
    for (const item of group.items) byHealth[item.rollup.health].push(item);
    return { ...group, byHealth };
  });
}

export interface SnapshotFigure {
  value: number;
  /** The one exception beneath the number, reading sensibly at zero. */
  line: string;
  /** True when the line names something wrong. */
  alert: boolean;
}

export interface DashboardSnapshot {
  areas: SnapshotFigure;
  responsibilities: SnapshotFigure;
  projects: SnapshotFigure;
  tasks: SnapshotFigure;
}

/**
 * The Outline's four numbers, each with one exception from the real totals:
 * areas with a responsibility behind, responsibilities behind, late
 * projects, blocked tasks. Areas count only those holding something you own.
 */
export function dashboardSnapshot(overview: Pick<ResponsibilityOverview, "areas" | "totals">): DashboardSnapshot {
  const { totals } = overview;
  const owningAreas = overview.areas.filter((area) => area.activeResponsibilities > 0);
  const areasBehind = owningAreas.filter((area) => area.byHealth.behind > 0).length;
  const responsibilities = Object.values(totals.byHealth).reduce((sum, value) => sum + value, 0);
  return {
    areas: {
      value: owningAreas.length,
      line: areasBehind > 0 ? `${areasBehind} with something behind` : "None with anything behind",
      alert: areasBehind > 0,
    },
    responsibilities: {
      value: responsibilities,
      line: totals.byHealth.behind > 0 ? `${totals.byHealth.behind} behind` : "None behind",
      alert: totals.byHealth.behind > 0,
    },
    projects: {
      value: totals.projects,
      line: totals.lateProjects > 0 ? `${totals.lateProjects} late` : "None late",
      alert: totals.lateProjects > 0,
    },
    tasks: {
      value: totals.openTasks,
      line: totals.blockedTasks > 0 ? `${totals.blockedTasks} blocked` : "None blocked",
      alert: totals.blockedTasks > 0,
    },
  };
}

export type ExceptionReason = "behind" | "at_risk" | "stale" | "not_measured";

export interface ResponsibilityException {
  responsibility: ResponsibilityWithRollup;
  reason: ExceptionReason;
  /** Its most important attention signal, if the work has one. */
  signal: ResponsibilityWorkSignal | null;
}

export interface OnTrackLine {
  areaId: string | null;
  /** "Fundraising: 2 of 2 on track". */
  label: string;
  /** The on-track ones not already listed as an exception (a stale number is). */
  responsibilities: ResponsibilityWithRollup[];
}

/** Why a responsibility needs a look, or null when it is on track with a current number. */
export function exceptionReason(responsibility: Pick<ResponsibilityWithRollup, "rollup">): ExceptionReason | null {
  const { health, metric } = responsibility.rollup;
  if (health === "behind" || health === "at_risk" || health === "not_measured") return health;
  return metric?.stale ? "stale" : null;
}

/**
 * The Exceptions view: active responsibilities that are behind, at risk,
 * not measured, or on track on a stale number (behind first), each with its
 * first attention signal; and, per area, one line for what is on track.
 */
export function responsibilityExceptions(
  areas: readonly Pick<ResponsibilityArea, "id" | "title" | "status">[],
  responsibilities: readonly ResponsibilityWithRollup[],
): { exceptions: ResponsibilityException[]; onTrack: OnTrackLine[] } {
  const active = sortByStatus(activeResponsibilities(responsibilities));
  const exceptions: ResponsibilityException[] = [];
  for (const responsibility of active) {
    const reason = exceptionReason(responsibility);
    if (!reason) continue;
    const signal = responsibility.rollup.workSummary.find((candidate) => candidate.tone === "attention") ?? null;
    exceptions.push({ responsibility, reason, signal });
  }
  const onTrack: OnTrackLine[] = [];
  for (const group of groupByArea(areas, active)) {
    const onTrackHere = group.items.filter((item) => item.rollup.health === "on_track");
    if (onTrackHere.length === 0) continue;
    onTrack.push({
      areaId: group.area?.id ?? null,
      label: `${group.area?.title ?? "Not in an area"}: ${onTrackHere.length} of ${group.items.length} on track`,
      responsibilities: onTrackHere.filter((item) => !item.rollup.metric?.stale),
    });
  }
  return { exceptions, onTrack };
}

// ---------------------------------------------------------------------------
// The responsibility page
// ---------------------------------------------------------------------------

export type WorkItemKind = "project" | "task" | "routine";

export const WORK_ITEM_KIND_LABEL: Record<WorkItemKind, string> = {
  project: "Project",
  task: "Task",
  routine: "Routine",
};

interface WorkItemBase {
  id: string;
  title: string;
  href: string;
  /** Why it needs attention ("Blocked", "Late · Nov 10", "Failed on its last run"), or null. */
  attention: string | null;
  /** A quiet note when nothing is wrong ("Due Dec 15", "Paused"), or null. */
  note: string | null;
}

export type WorkItem =
  | (WorkItemBase & { kind: "project"; project: ResponsibilityProjectSummary })
  | (WorkItemBase & { kind: "task"; task: ResponsibilityTaskSummary })
  | (WorkItemBase & { kind: "routine"; routine: ResponsibilityRoutineSummary });

export function isFinishedProject(project: Pick<ResponsibilityProjectSummary, "status" | "archivedAt">): boolean {
  return !!project.archivedAt || project.status === "completed" || project.status === "cancelled";
}

/** Routines whose last run failed, from the work summary (the routine list carries no run result). */
export function failedRoutineIds(workSummary: readonly ResponsibilityWorkSignal[]): Set<string> {
  return new Set(
    workSummary
      .filter((signal) => signal.kind === "routine_failed" && signal.refType === "routine" && signal.refId)
      .map((signal) => signal.refId!),
  );
}

/** Everything a work-summary kind covers, "more" lines included. */
export function signalCount(workSummary: readonly ResponsibilityWorkSignal[], kind: ResponsibilityWorkSignal["kind"]): number {
  return workSummary.filter((signal) => signal.kind === kind).reduce((sum, signal) => sum + signal.count, 0);
}

export interface ResponsibilityWorkList {
  /** Unfinished projects, open tasks and routines that are not archived: what needs attention first. */
  items: WorkItem[];
  /** Finished items left out (completed or cancelled projects, done tasks, archived routines). */
  finished: number;
}

const KIND_RANK: Record<WorkItemKind, number> = { project: 0, task: 1, routine: 2 };

/**
 * The work under a responsibility as one list: projects, tasks and routines
 * together, anything needing attention (late, blocked, failed) first, then
 * the rest; projects before tasks before routines, otherwise in the order
 * the server gave. Finished items are counted, not listed.
 */
export function responsibilityWorkList(
  detail: Pick<ResponsibilityDetail, "projects" | "tasks" | "routines" | "rollup">,
  now: Date,
): ResponsibilityWorkList {
  const failed = failedRoutineIds(detail.rollup.workSummary);
  const items: WorkItem[] = [];
  let finished = 0;
  for (const project of detail.projects) {
    if (isFinishedProject(project)) {
      finished += 1;
      continue;
    }
    const due = describeNextDue(project.targetDate, now);
    items.push({
      kind: "project",
      id: project.id,
      title: project.name,
      href: projectUrl(project),
      attention: due?.late ? `Late · ${due.label}` : null,
      note: due && !due.late ? `Due ${due.label}` : null,
      project,
    });
  }
  for (const task of detail.tasks) {
    if (isTerminalTaskStatus(task.status)) {
      finished += 1;
      continue;
    }
    items.push({
      kind: "task",
      id: task.id,
      title: task.title,
      href: issueUrl(task),
      attention: task.status === "blocked" ? "Blocked" : null,
      note: null,
      task,
    });
  }
  for (const routine of detail.routines) {
    if (routine.status === "archived") {
      finished += 1;
      continue;
    }
    items.push({
      kind: "routine",
      id: routine.id,
      title: routine.title,
      href: routinePath(routine.id),
      attention: failed.has(routine.id) ? "Failed on its last run" : null,
      note: routine.status === "paused" ? "Paused" : null,
      routine,
    });
  }
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      Number(b.item.attention !== null) - Number(a.item.attention !== null)
      || KIND_RANK[a.item.kind] - KIND_RANK[b.item.kind]
      || a.index - b.index)
    .map(({ item }) => item);
  return { items: ordered, finished };
}

export interface WorkCount {
  value: number;
  line: string;
  alert: boolean;
}

/**
 * The Scorecard's three counts, each with one exception line: unfinished
 * projects and how many are late; open tasks, how many are blocked and how
 * many are with agents; routines and how many failed or are paused.
 */
export function responsibilityWorkCounts(
  detail: Pick<ResponsibilityDetail, "projects" | "routines" | "rollup">,
): { projects: WorkCount; tasks: WorkCount; routines: WorkCount } {
  const { rollup } = detail;
  const late = rollup.overdueProjects.length;
  const failed = signalCount(rollup.workSummary, "routine_failed");
  const paused = detail.routines.filter((routine) => routine.status === "paused").length;
  const routineParts = [failed > 0 ? `${failed} failed` : null, paused > 0 ? `${paused} paused` : null].filter(Boolean);
  return {
    projects: {
      value: detail.projects.filter((project) => !isFinishedProject(project)).length,
      line: late > 0 ? `${late} late` : "None late",
      alert: late > 0,
    },
    tasks: {
      value: rollup.openTasks,
      line: `${rollup.blockedTasks > 0 ? `${rollup.blockedTasks} blocked` : "None blocked"}, ${
        rollup.agentTasks > 0 ? `${rollup.agentTasks} with agents` : "none with agents"
      }`,
      alert: rollup.blockedTasks > 0,
    },
    routines: {
      value: rollup.routines,
      line: routineParts.length > 0 ? routineParts.join(", ") : "None failed or paused",
      alert: failed > 0,
    },
  };
}

/** The first `limit` items and how many more there are. */
export function capList<T>(items: readonly T[], limit: number): { shown: T[]; more: number } {
  return { shown: items.slice(0, limit), more: Math.max(0, items.length - limit) };
}

// ---------------------------------------------------------------------------
// Why a responsibility has its status (the Board's tiles)
// ---------------------------------------------------------------------------

type MetricForGap = Pick<ResponsibilityMetricSummary, "name" | "unit" | "target" | "current" | "direction"> &
  Partial<Pick<ResponsibilityMetricSummary, "kind" | "low" | "high">>;

/** A difference in the metric's own unit; a gap between percentages is in points. */
function formatGapAmount(value: number, unit: string | null): string {
  if (unit?.trim() === "%") {
    const points = formatMetricValue(value, null);
    return `${points} ${value === 1 ? "point" : "points"}`;
  }
  return formatMetricValue(value, unit);
}

/** Rounded to the precision readings are shown at, so 0.1 + 0.2 reads as 0.3. */
function roundGap(value: number): number {
  return Math.round(value * 100) / 100;
}

/** "10–20", "18–24 months", "$10–$20", "40%–60%": a word unit is said once, after the range. */
function formatRange(low: number, high: number, unit: string | null): string {
  return formatMetricRange(low, high, unit);
}

/**
 * How far the number is from its bar, in the metric's own terms: "11 short
 * of 20", "$8,000 short of $20,000", "15 points short of 60%", "6 days over
 * the limit of 30 days", "18 days inside the limit of 30 days", "Right at the
 * target of 4", "2 below the range 10–20", "Yes" / "Not yet". Null without a
 * reading or a complete bar.
 */
export function describeMetricGap(metric: MetricForGap): string | null {
  const { current, unit } = metric;
  if (current === null) return null;
  if (metric.kind === "yes_no") return current >= 1 ? "Yes" : "Not yet";
  if (metric.kind === "range") {
    const { low, high } = metric;
    if (low === null || low === undefined || high === null || high === undefined) return null;
    const range = formatRange(low, high, unit);
    if (current < low) return `${formatGapAmount(roundGap(low - current), unit)} below the range ${range}`;
    if (current > high) return `${formatGapAmount(roundGap(current - high), unit)} above the range ${range}`;
    return `Inside the range ${range}`;
  }
  const { target } = metric;
  if (target === null) return null;
  const atMost = metric.direction === "at_most";
  const diff = roundGap(atMost ? current - target : target - current);
  const targetText = formatMetricValue(target, unit);
  const amount = formatGapAmount(Math.abs(diff), unit);
  if (atMost) {
    if (diff > 0) return `${amount} over the limit of ${targetText}`;
    if (diff < 0) return `${amount} inside the limit of ${targetText}`;
    return `Right at the limit of ${targetText}`;
  }
  if (diff > 0) return `${amount} short of ${targetText}`;
  if (diff < 0) return `${amount} past the target of ${targetText}`;
  return `Right at the target of ${targetText}`;
}

/**
 * The bar as it reads under the number on a card: "of 20", "limit 24 hours",
 * "range 10–20", before a reading "target 20"; "no target set" when the bar
 * is incomplete; nothing for a yes-or-no bar (its name is the statement).
 */
export function describeTargetPhrase(metric: MetricForGap): string | null {
  if (metric.kind === "yes_no") return null;
  if (metric.kind === "range") {
    return metric.low === null || metric.low === undefined || metric.high === null || metric.high === undefined
      ? "no range set"
      : `range ${formatRange(metric.low, metric.high, metric.unit)}`;
  }
  if (metric.target === null) return "no target set";
  const target = formatMetricValue(metric.target, metric.unit);
  if (metric.direction === "at_most") return `limit ${target}`;
  return metric.current === null ? `target ${target}` : `of ${target}`;
}

/** The reading on a card, value and unit together ("20 hours", "Yes"); null before the first one. Same as every view's reading. */
export function describeReadingValue(metric: Pick<ResponsibilityMetricSummary, "current" | "unit"> & Partial<Pick<ResponsibilityMetricSummary, "kind">>): string | null {
  return describeMetricReading({ name: "", target: null, direction: null, attainment: null, ...metric }).current;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** What a responsibility is missing to be measured, or null when it has a reading and a complete bar. */
export function describeMissingMeasure(
  metric: (Pick<ResponsibilityMetricSummary, "name" | "target" | "current"> & Partial<Pick<ResponsibilityMetricSummary, "kind" | "low" | "high">>) | null,
): string | null {
  if (!metric) return "No number set: add what you measure and a target.";
  const name = lowerFirst(metric.name.trim());
  if (metric.kind === "yes_no") return metric.current === null ? "No answer yet." : null;
  if (metric.kind === "range") {
    if (metric.low === null || metric.low === undefined || metric.high === null || metric.high === undefined) return `No range set for ${name}.`;
  } else if (metric.target === null) {
    return `No target set for ${name}.`;
  }
  if (metric.current === null) return `No reading of ${name} yet.`;
  return null;
}

export type ExplanationLineKind = ResponsibilityWorkSignal["kind"] | "override" | "no_work" | "no_open_work";

export interface ExplanationLine {
  kind: ExplanationLineKind;
  /** "holding": something holding the number back; "keeping": what keeps it on track; "note": a plain remark. */
  role: "holding" | "keeping" | "note";
  text: string;
}

export interface StatusExplanation {
  /** How far the number is from its target ("11 short of 20"), or null. */
  gap: string | null;
  /** What is missing to measure it ("No reading of offers accepted yet."), or null. */
  missing: string | null;
  /** The lines shown, most important first. */
  lines: ExplanationLine[];
  /** Further lines of the same kind that were not shown. */
  more: number;
}

/** Signals that hold a number back even though the server files them as neutral. */
const HOLDING_NEUTRAL_KINDS = new Set<ResponsibilityWorkSignal["kind"]>(["routine_paused", "tasks_open_unassigned"]);
/** What keeps an on-track number there, best evidence first. */
const KEEPING_KINDS: readonly ResponsibilityWorkSignal["kind"][] = ["tasks_completed_recently", "tasks_open_agent", "routine_active"];

/**
 * Why a responsibility has its status, in words, from its metric, its status
 * and its work summary:
 * - behind or at risk: the gap to the target, then what in the work holds it
 *   back by name (attention signals, paused routines, unassigned tasks); with
 *   none, what work there is and who has it, or that nothing is filed under it;
 * - not measured: what is missing, then any attention signals (or that no
 *   work is filed under it);
 * - on track: the gap (how far past or inside the target), then a stale
 *   reading if there is one, otherwise one line on what keeps it there.
 * A status set by hand leads with the owner's note.
 */
export function explainResponsibilityStatus(
  responsibility: Pick<ResponsibilityWithRollup, "rollup" | "healthNote">,
  limit = 2,
): StatusExplanation {
  const { rollup } = responsibility;
  const { health, metric, workSummary } = rollup;
  const gap = metric ? describeMetricGap(metric) : null;
  const missing = gap ? null : describeMissingMeasure(metric);
  const lines: ExplanationLine[] = [];
  if (rollup.healthOverridden) {
    const note = responsibility.healthNote?.trim();
    const label = RESPONSIBILITY_HEALTH_LABEL[health].toLowerCase();
    lines.push({ kind: "override", role: "note", text: note ? `You marked it ${label}: ${note}` : `You marked it ${label}.` });
  }
  const attention = workSummary.filter((signal) => signal.tone === "attention");
  let candidates: ExplanationLine[];
  if (health === "on_track") {
    const stale = attention.filter((signal) => signal.kind === "metric_stale");
    const keeping = KEEPING_KINDS.map((kind) => workSummary.find((signal) => signal.kind === kind)).find(Boolean);
    candidates = stale.length > 0
      ? stale.map((signal) => ({ kind: signal.kind, role: "holding" as const, text: signal.text }))
      : keeping ? [{ kind: keeping.kind, role: "keeping" as const, text: keeping.text }] : [];
  } else {
    const holding = [
      ...attention,
      ...(health === "not_measured" ? [] : workSummary.filter((signal) => HOLDING_NEUTRAL_KINDS.has(signal.kind))),
    ];
    candidates = holding.map((signal) => ({ kind: signal.kind, role: "holding" as const, text: signal.text }));
    if (candidates.length === 0 && lines.length === 0) {
      // Nothing flagged: say what work there is and who has it, or that there is none.
      const hasWork = rollup.projects + rollup.routines + rollup.openTasks + rollup.doneTasks > 0;
      if (!hasWork) {
        candidates = [{ kind: "no_work", role: "holding", text: "No work is filed under this yet." }];
      } else if (health !== "not_measured") {
        const present = workSummary.map((signal) => ({ kind: signal.kind, role: "note" as const, text: signal.text }));
        candidates = present.length > 0 ? present : [{ kind: "no_open_work", role: "note", text: "Nothing under this is open right now." }];
      }
    }
  }
  const room = Math.max(0, limit - lines.length);
  const shown = candidates.slice(0, room);
  return { gap: gap ?? (missing ? null : rollup.statusSentence), missing, lines: [...lines, ...shown], more: candidates.length - shown.length };
}

// ---------------------------------------------------------------------------
// How each project, task and routine bears on the number (One screen)
// ---------------------------------------------------------------------------

/** "holding": holding the number back; "moving": moving it; "neutral": neither, as far as the data shows. */
export type WorkBearing = "holding" | "moving" | "neutral";

export interface BearingItem {
  item: WorkItem;
  bearing: WorkBearing;
  /** Why, in a few words: "Blocked", "3 days late (due Nov 10)", "In progress with CodexCoder". */
  reason: string;
  /** A finished item listed because it finished recently. */
  finished: boolean;
}

const BEARING_RANK: Record<WorkBearing, number> = { holding: 0, moving: 1, neutral: 2 };
const GOOD_LAST_RUN = /last run (completed|succeeded|created a task)/;

/** What follows "<title> is active, " in a routine's signal: "last run completed on 2026-11-10, next run …". */
function routineRunDetail(signal: ResponsibilityWorkSignal | undefined, title: string): string | null {
  if (!signal) return null;
  const prefix = `${title} is active, `;
  return signal.text.startsWith(prefix) ? signal.text.slice(prefix.length) : null;
}

function agentLabel(agentId: string, agentName: (id: string) => string | undefined): string {
  return agentName(agentId) ?? "an agent";
}

/**
 * Each project, task and routine under a responsibility, marked with how it
 * bears on the number as far as the detail shows: holding it back (late,
 * blocked, failed, paused, unassigned), moving it (with an agent, due soon
 * while in progress, an active routine whose last run went well, recently
 * completed), or neutral. Holding first, then moving, then neutral, then the
 * recently completed; otherwise the order of `responsibilityWorkList`.
 *
 * The contract carries no per-item contribution to the metric, so this says
 * what each item's own state implies, nothing more.
 */
export function workBearings(
  detail: Pick<ResponsibilityDetail, "projects" | "tasks" | "routines" | "rollup" | "ownerUserId">,
  now: Date,
  agentName: (id: string) => string | undefined = () => undefined,
): BearingItem[] {
  const { items } = responsibilityWorkList(detail, now);
  const signals = detail.rollup.workSummary;
  const overdue = new Map(detail.rollup.overdueProjects.map((project) => [project.id, project]));
  const today = localDateKey(now);
  const marked: BearingItem[] = items.map((item) => {
    if (item.kind === "project") {
      const { project } = item;
      const due = describeNextDue(project.targetDate, now);
      if (due?.late) {
        const days = overdue.get(project.id)?.daysOverdue ?? daysBetween(`${project.targetDate}T00:00:00`, now);
        return { item, bearing: "holding", reason: `${days} ${days === 1 ? "day" : "days"} late (due ${due.label})`, finished: false };
      }
      const daysUntil = project.targetDate && project.targetDate >= today
        ? Math.round((new Date(`${project.targetDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / (24 * 60 * 60 * 1000))
        : null;
      const dueSoon = daysUntil !== null && daysUntil <= RESPONSIBILITY_DUE_SOON_DAYS;
      if (project.status === "in_progress" && (dueSoon || project.leadAgentId)) {
        const parts = [dueSoon && due ? `Due ${due.label}, in progress` : "In progress"];
        if (project.leadAgentId) parts.push(`led by ${agentLabel(project.leadAgentId, agentName)}`);
        return { item, bearing: "moving", reason: parts.join(", "), finished: false };
      }
      const state = project.status === "backlog" || project.status === "planned" ? "Not started" : "In progress";
      return { item, bearing: "neutral", reason: due ? `${state}, due ${due.label}` : state, finished: false };
    }
    if (item.kind === "task") {
      const { task } = item;
      if (task.status === "blocked") return { item, bearing: "holding", reason: "Blocked", finished: false };
      if (!task.assigneeAgentId && !task.assigneeUserId) return { item, bearing: "holding", reason: "Not assigned to anyone", finished: false };
      if (task.assigneeAgentId) {
        const name = agentLabel(task.assigneeAgentId, agentName);
        const reason = task.status === "in_progress" ? `In progress with ${name}`
          : task.status === "in_review" ? `In review with ${name}`
          : `With ${name}, not started`;
        return { item, bearing: "moving", reason, finished: false };
      }
      const who = task.assigneeUserId === detail.ownerUserId ? "you" : "a person";
      return { item, bearing: "neutral", reason: task.status === "in_review" ? `In review with ${who}` : `With ${who}`, finished: false };
    }
    const { routine } = item;
    if (item.attention) return { item, bearing: "holding", reason: item.attention, finished: false };
    if (routine.status === "paused") return { item, bearing: "holding", reason: "Paused", finished: false };
    if (!routine.assigneeAgentId) return { item, bearing: "holding", reason: "No agent runs it", finished: false };
    const detailText = routineRunDetail(
      signals.find((signal) => signal.kind === "routine_active" && signal.refId === routine.id),
      routine.title,
    );
    if (detailText && GOOD_LAST_RUN.test(detailText)) {
      return { item, bearing: "moving", reason: `Active, ${detailText}`, finished: false };
    }
    return { item, bearing: "neutral", reason: detailText ? `Active, ${detailText}` : "Active", finished: false };
  });
  const ordered = marked
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => BEARING_RANK[a.entry.bearing] - BEARING_RANK[b.entry.bearing] || a.index - b.index)
    .map(({ entry }) => entry);

  // Tasks finished in the last few days moved the number; list them last.
  const recent = detail.tasks
    .filter((task) => task.status === "done" && daysBetween(task.updatedAt, now) < RESPONSIBILITY_RECENTLY_COMPLETED_DAYS)
    .map((task): BearingItem => ({
      item: { kind: "task", id: task.id, title: task.title, href: issueUrl(task), attention: null, note: null, task },
      bearing: "moving",
      reason: `Completed ${describeReadingAge(task.updatedAt, now)}`,
      finished: true,
    }));
  return [...ordered, ...recent];
}
