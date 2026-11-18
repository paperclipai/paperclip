import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companyMemberships,
  issues,
  projects,
  responsibilities,
  responsibilityLinks,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  COMPANY_ARTIFACTS_MAX_LIMIT,
  RESPONSIBILITY_ARTIFACT_COUNT_LIMIT,
  RESPONSIBILITY_DETAIL_ARTIFACT_LIMIT,
  RESPONSIBILITY_DETAIL_TASK_LIMIT,
  RESPONSIBILITY_DUE_SOON_DAYS,
  RESPONSIBILITY_LOOSE_LIST_LIMIT,
  RESPONSIBILITY_LOOSE_TASK_LIMIT,
  RESPONSIBILITY_METRIC_STALE_DAYS,
  RESPONSIBILITY_RECENTLY_COMPLETED_DAYS,
  RESPONSIBILITY_WORK_SIGNAL_ITEM_LIMIT,
  RESPONSIBILITY_WORK_SIGNAL_KINDS,
  RESPONSIBILITY_WORK_SIGNAL_TONES,
  type CompanyArtifact,
  type CreateResponsibility,
  type DelegateResponsibility,
  type IssueStatus,
  type ProjectStatus,
  type Responsibility,
  type ResponsibilityArea,
  type ResponsibilityDelegationMode,
  type ResponsibilityDetail,
  type ResponsibilityHealth,
  type ResponsibilityLink,
  type ResponsibilityLinkLookupEntry,
  type ResponsibilityLooseWork,
  type ResponsibilityMetricDirection,
  type ResponsibilityMetricSummary,
  type ResponsibilityOverdueProject,
  type ResponsibilityOverview,
  type ResponsibilityOverviewArea,
  type ResponsibilityRollup,
  type ResponsibilityProjectSummary,
  type ResponsibilityRoutineSummary,
  type ResponsibilitySkillSummary,
  type ResponsibilityStatus,
  type ResponsibilityTaskSummary,
  type ResponsibilityWithRollup,
  type ResponsibilityWorkSignal,
  type ResponsibilityWorkSignalKind,
  type RoutineStatus,
  type UpdateResponsibility,
  type ResponsibilityBarField,
  type ResponsibilityBarProposalBar,
  type ResponsibilityBarMetric,
  type ResponsibilityBarRow,
  type ResponsibilityMetricKind,
  RESPONSIBILITY_BAR_TEMPLATES,
  directionalAttainment,
  normalizeResponsibilityBar,
  normalizeResponsibilityReading,
  responsibilityBarIssues,
  responsibilityBarMissingForActive,
  responsibilityHasMetric,
  formatResponsibilityMetricValue,
  resolveResponsibilityMetricKind,
  responsibilityAttainment,
  responsibilityHealthFromAttainment,
  responsibilityKindHasTarget,
  responsibilityStatusRule,
  responsibilityStatusSentence,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { companyArtifactsService } from "./company-artifacts.js";
import {
  companySkillService,
  ONBOARDING_FIRST_TASK_SKILL_KEY,
  PAPERCLIP_CORE_SKILL_KEYS,
} from "./company-skills.js";
import { issueService } from "./issues.js";
import { responsibilityAreaService } from "./responsibility-areas.js";
import { archivePrimaryMirror, recordPrimaryReading, type MetricActor } from "./responsibility-metric-store.js";
import { routineService } from "./routines.js";

type ResponsibilityRow = typeof responsibilities.$inferSelect;
type LinkRow = typeof responsibilityLinks.$inferSelect;
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** SQL read predicates for the acting principal; the route derives them from the actor. */
export interface ResponsibilityReadScope {
  issueReadCondition: SQL<boolean>;
  projectReadCondition: SQL<boolean>;
}

export type ResponsibilityLinkTarget =
  | { kind: "project"; id: string }
  | { kind: "issue"; id: string }
  | { kind: "routine"; id: string };

export type ResponsibilityCreateActor =
  | { type: "board"; userId: string }
  | { type: "agent"; agentId: string };

const OPEN_TASK = sql`${issues.status} not in ('done', 'cancelled')`;
const UNFINISHED_PROJECT = sql`${projects.status} not in ('completed', 'cancelled') and ${projects.archivedAt} is null`;
/** Statuses whose links put work "under a responsibility" for loose work and lookups. */
const LIVE_STATUSES = ["proposed", "active"] as const;
const LIVE_STATUS_SQL = sql`('proposed', 'active')`;
const DAY_MS = 86_400_000;

/** Paperclip's own coordination and onboarding skills: plumbing, not capabilities behind a responsibility. */
const PLUMBING_SKILL_KEYS = new Set<string>([
  ...PAPERCLIP_CORE_SKILL_KEYS,
  ONBOARDING_FIRST_TASK_SKILL_KEY,
]);

function numberOrNull(value: number | string | null) {
  return value === null ? null : Number(value);
}

function toResponsibility(row: ResponsibilityRow): Responsibility {
  return {
    ...row,
    metricKind: resolveResponsibilityMetricKind(row.metricKind, row.metricUnit),
    metricTarget: numberOrNull(row.metricTarget),
    metricLow: numberOrNull(row.metricLow),
    metricHigh: numberOrNull(row.metricHigh),
    metricCurrent: numberOrNull(row.metricCurrent),
    metricDirection: (row.metricDirection ?? null) as Responsibility["metricDirection"],
    status: row.status as Responsibility["status"],
    source: row.source as Responsibility["source"],
    healthOverride: (row.healthOverride ?? null) as Responsibility["healthOverride"],
  };
}

function toLink(row: LinkRow): ResponsibilityLink {
  return { ...row };
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Metric, status and status sentence (pure)
// ---------------------------------------------------------------------------

/**
 * Volume and percentage attainment: how far `current` is toward `target`, 1
 * meaning met, rounded to 4 places. See `directionalAttainment` in
 * packages/shared/src/responsibility-bars.ts, which owns every template's rule.
 */
export function computeAttainment(
  direction: ResponsibilityMetricDirection,
  target: number | null,
  current: number | null,
): number | null {
  return directionalAttainment(direction, target, current);
}

/** on_track at >= 1, at_risk at >= `RESPONSIBILITY_AT_RISK_THRESHOLD`, behind below; not_measured without attainment. */
export function healthFromAttainment(attainment: number | null): ResponsibilityHealth {
  return responsibilityHealthFromAttainment(attainment);
}

export interface ResponsibilityMetricInput {
  /** Null or missing on rows saved before templates existed: inferred from the unit. */
  kind?: string | null;
  name: string | null;
  unit: string | null;
  target: number | null;
  /** Range only. */
  low?: number | null;
  high?: number | null;
  current: number | null;
  direction: ResponsibilityMetricDirection | null;
  updatedAt: Date | null;
}

/** The bar's metric for status derivation, or null when no metric name is set. */
export function barMetricFrom(input: Omit<ResponsibilityMetricInput, "current" | "updatedAt">): ResponsibilityBarMetric | null {
  const name = input.name?.trim();
  if (!name) return null;
  const kind = resolveResponsibilityMetricKind(input.kind, input.unit);
  const usesTarget = responsibilityKindHasTarget(kind);
  return {
    kind,
    name,
    unit: kind === "percentage" ? "%" : kind === "yes_no" ? null : input.unit?.trim() || null,
    direction: usesTarget ? input.direction ?? "at_least" : null,
    target: usesTarget ? input.target : null,
    low: kind === "range" ? input.low ?? null : null,
    high: kind === "range" ? input.high ?? null : null,
  };
}

export function buildMetricSummary(input: ResponsibilityMetricInput, now: Date = new Date()): ResponsibilityMetricSummary | null {
  const metric = barMetricFrom(input);
  if (!metric) return null;
  const updatedAt = input.updatedAt ? new Date(input.updatedAt) : null;
  return {
    ...metric,
    current: input.current,
    attainment: responsibilityAttainment(metric, input.current),
    statusRule: responsibilityStatusRule(metric),
    updatedAt,
    stale: input.current !== null && updatedAt !== null
      && now.getTime() - updatedAt.getTime() > RESPONSIBILITY_METRIC_STALE_DAYS * DAY_MS,
  };
}

/**
 * A value with its unit: "%" is a suffix ("60%"), any other unit without
 * letters is a prefix ("$1,200"), and a word unit follows with a space ("3
 * days") unless `withWordUnit` is false.
 */
export function formatMetricValue(value: number, unit: string | null, withWordUnit = true): string {
  return formatResponsibilityMetricValue(value, unit, withWordUnit);
}

/**
 * The deterministic status sentence (no trailing period), per template; see
 * `responsibilityStatusSentence` in packages/shared/src/responsibility-bars.ts.
 */
export function buildStatusSentence(metric: ResponsibilityMetricSummary | null): string {
  return responsibilityStatusSentence(metric, metric?.current ?? null, metric?.attainment ?? null);
}

// ---------------------------------------------------------------------------
// Work summary (pure)
// ---------------------------------------------------------------------------

export interface ResponsibilityWorkProject {
  id: string;
  name: string;
  status: string;
  /** `YYYY-MM-DD`. */
  targetDate: string | null;
  /** targetDate - today, in days; negative when past. */
  daysUntil: number | null;
  archived: boolean;
}

export interface ResponsibilityWorkRoutine {
  id: string;
  title: string;
  status: string;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
}

export interface ResponsibilityWorkInput {
  projects: ResponsibilityWorkProject[];
  blockedTasks: Array<{ id: string; title: string }>;
  /** Open tasks grouped by assignee; both ids null for unassigned. `name` is the agent's or person's name. */
  openByAssignee: Array<{ agentId: string | null; userId: string | null; name: string | null; count: number }>;
  completedRecently: number;
  routines: ResponsibilityWorkRoutine[];
}

export type RollupCounts = {
  totalTasks: number;
  openTasks: number;
  blockedTasks: number;
  agentTasks: number;
  userTasks: number;
  doneTasks: number;
};

const emptyCounts = (): RollupCounts => ({
  totalTasks: 0, openTasks: 0, blockedTasks: 0, agentTasks: 0, userTasks: 0, doneTasks: 0,
});

const emptyWork = (): ResponsibilityWorkInput => ({
  projects: [], blockedTasks: [], openByAssignee: [], completedRecently: 0, routines: [],
});

const SIGNAL_TONE: Record<ResponsibilityWorkSignalKind, ResponsibilityWorkSignal["tone"]> = {
  metric_stale: "attention",
  project_late: "attention",
  routine_failed: "attention",
  task_blocked: "attention",
  project_due_soon: "neutral",
  routine_paused: "neutral",
  tasks_open_agent: "neutral",
  tasks_open_person: "neutral",
  tasks_open_unassigned: "neutral",
  tasks_completed_recently: "good",
  routine_active: "good",
};

/** The "more" line when a per-item kind has more than `RESPONSIBILITY_WORK_SIGNAL_ITEM_LIMIT` lines. */
const MORE_TEXT: Partial<Record<ResponsibilityWorkSignalKind, (count: number) => string>> = {
  project_late: (n) => `${n} more ${plural(n, "project is", "projects are")} past the target date`,
  routine_failed: (n) => `${n} more ${plural(n, "routine", "routines")} failed on the last run`,
  task_blocked: (n) => `${n} more ${plural(n, "task is", "tasks are")} blocked`,
  project_due_soon: (n) => `${n} more ${plural(n, "project is", "projects are")} due soon`,
  routine_paused: (n) => `${n} more ${plural(n, "routine is", "routines are")} paused`,
  tasks_open_agent: (n) => `${n} more open ${plural(n, "task", "tasks")} with other agents`,
  tasks_open_person: (n) => `${n} more open ${plural(n, "task", "tasks")} with other people`,
  routine_active: (n) => `${n} more ${plural(n, "routine is", "routines are")} active`,
};

const RUN_OUTCOME: Record<string, string> = {
  completed: "completed",
  failed: "failed",
  skipped: "was skipped",
  coalesced: "merged into another run",
  issue_created: "created a task",
  received: "started",
};

function isUnfinishedProject(project: ResponsibilityWorkProject) {
  return !project.archived && project.status !== "completed" && project.status !== "cancelled";
}

export function overdueProjectsFrom(projectsList: readonly ResponsibilityWorkProject[]): ResponsibilityOverdueProject[] {
  return projectsList
    .filter((project) => isUnfinishedProject(project) && project.targetDate !== null && project.daysUntil !== null && project.daysUntil < 0)
    .sort((a, b) => a.targetDate!.localeCompare(b.targetDate!) || a.name.localeCompare(b.name))
    .map((project) => ({ id: project.id, name: project.name, targetDate: project.targetDate!, daysOverdue: -project.daysUntil! }));
}

/**
 * Pure: the ordered signals bubbled up from the work under a responsibility
 * (plus a stale-metric line). Ordered by tone, then by
 * `RESPONSIBILITY_WORK_SIGNAL_KINDS`; within a kind, in the order given.
 */
export function buildWorkSummary(input: {
  responsibilityId: string;
  metric: ResponsibilityMetricSummary | null;
  work: ResponsibilityWorkInput;
  now?: Date;
}): ResponsibilityWorkSignal[] {
  const now = input.now ?? new Date();
  const byKind = new Map<ResponsibilityWorkSignalKind, ResponsibilityWorkSignal[]>();
  const add = (
    kind: ResponsibilityWorkSignalKind,
    text: string,
    refType: ResponsibilityWorkSignal["refType"],
    refId: string | null,
    count = 1,
  ) => {
    const list = byKind.get(kind) ?? [];
    list.push({ kind, tone: SIGNAL_TONE[kind], text, refType, refId, count });
    byKind.set(kind, list);
  };
  const { work } = input;

  if (input.metric?.stale && input.metric.updatedAt) {
    const days = Math.floor((now.getTime() - input.metric.updatedAt.getTime()) / DAY_MS);
    add("metric_stale", `${input.metric.name} was last updated ${days} ${plural(days, "day", "days")} ago`, "responsibility", input.responsibilityId);
  }
  for (const project of overdueProjectsFrom(work.projects)) {
    add("project_late", `${project.name} is ${project.daysOverdue} ${plural(project.daysOverdue, "day", "days")} past its target date`, "project", project.id);
  }
  const dueSoon = work.projects
    .filter((project) => isUnfinishedProject(project) && project.daysUntil !== null
      && project.daysUntil >= 0 && project.daysUntil <= RESPONSIBILITY_DUE_SOON_DAYS)
    .sort((a, b) => a.daysUntil! - b.daysUntil! || a.name.localeCompare(b.name));
  for (const project of dueSoon) {
    const days = project.daysUntil!;
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    add("project_due_soon", `${project.name} is due ${when}`, "project", project.id);
  }
  for (const task of work.blockedTasks) add("task_blocked", `${task.title} is blocked`, "issue", task.id);

  const assignees = [...work.openByAssignee].sort((a, b) => b.count - a.count || (a.name ?? "").localeCompare(b.name ?? ""));
  for (const row of assignees) {
    const tasks = `${row.count} open ${plural(row.count, "task", "tasks")}`;
    if (row.agentId) add("tasks_open_agent", `${tasks} with ${row.name ?? "an agent"}`, "agent", row.agentId, row.count);
    else if (row.userId) add("tasks_open_person", `${tasks} with ${row.name ?? "a person"}`, "user", row.userId, row.count);
    else add("tasks_open_unassigned", `${tasks} not assigned to anyone`, null, null, row.count);
  }
  if (work.completedRecently > 0) {
    const n = work.completedRecently;
    add("tasks_completed_recently", `${n} ${plural(n, "task", "tasks")} completed in the last ${RESPONSIBILITY_RECENTLY_COMPLETED_DAYS} days`, null, null, n);
  }

  const routinesSorted = [...work.routines].sort((a, b) => a.title.localeCompare(b.title));
  for (const routine of routinesSorted) {
    if (routine.status === "archived") continue;
    if (routine.status === "paused") {
      add("routine_paused", `${routine.title} is paused`, "routine", routine.id);
      continue;
    }
    if (routine.lastRunStatus === "failed") {
      const on = routine.lastRunAt ? ` (${isoDate(routine.lastRunAt)})` : "";
      add("routine_failed", `${routine.title} failed on its last run${on}`, "routine", routine.id);
      continue;
    }
    const parts = [`${routine.title} is active`];
    if (routine.lastRunStatus && routine.lastRunAt) {
      parts.push(`last run ${RUN_OUTCOME[routine.lastRunStatus] ?? routine.lastRunStatus} on ${isoDate(routine.lastRunAt)}`);
    }
    if (routine.nextRunAt) parts.push(`next run ${isoDate(routine.nextRunAt)}`);
    add("routine_active", parts.join(", "), "routine", routine.id);
  }

  const kindOrder = new Map(RESPONSIBILITY_WORK_SIGNAL_KINDS.map((kind, index) => [kind, index]));
  const toneOrder = new Map(RESPONSIBILITY_WORK_SIGNAL_TONES.map((tone, index) => [tone, index]));
  const kinds = [...byKind.keys()].sort((a, b) =>
    toneOrder.get(SIGNAL_TONE[a])! - toneOrder.get(SIGNAL_TONE[b])! || kindOrder.get(a)! - kindOrder.get(b)!);
  const out: ResponsibilityWorkSignal[] = [];
  for (const kind of kinds) {
    const list = byKind.get(kind)!;
    const more = MORE_TEXT[kind];
    if (!more || list.length <= RESPONSIBILITY_WORK_SIGNAL_ITEM_LIMIT) {
      out.push(...list);
      continue;
    }
    const shown = list.slice(0, RESPONSIBILITY_WORK_SIGNAL_ITEM_LIMIT);
    const rest = list.slice(RESPONSIBILITY_WORK_SIGNAL_ITEM_LIMIT);
    const restCount = rest.reduce((sum, signal) => sum + signal.count, 0);
    out.push(...shown, { kind, tone: SIGNAL_TONE[kind], text: more(restCount), refType: null, refId: null, count: restCount });
  }
  return out;
}

/** Pure: the rollup the API returns, from the metric, the override and the work underneath. */
export function buildResponsibilityRollup(input: {
  responsibilityId: string;
  metric: ResponsibilityMetricInput;
  healthOverride: string | null;
  counts: RollupCounts;
  work: ResponsibilityWorkInput;
  now?: Date;
}): ResponsibilityRollup {
  const now = input.now ?? new Date();
  const metric = buildMetricSummary(input.metric, now);
  const computedHealth = healthFromAttainment(metric?.attainment ?? null);
  const override = input.healthOverride === "behind" || input.healthOverride === "at_risk" || input.healthOverride === "on_track"
    ? input.healthOverride
    : null;
  const unfinished = input.work.projects.filter(isUnfinishedProject).map((project) => project.targetDate)
    .filter((date): date is string => date !== null).sort();
  return {
    health: override ?? computedHealth,
    computedHealth,
    healthOverridden: override !== null,
    metric,
    statusSentence: buildStatusSentence(metric),
    workSummary: buildWorkSummary({ responsibilityId: input.responsibilityId, metric, work: input.work, now }),
    projects: input.work.projects.length,
    routines: input.work.routines.filter((routine) => routine.status !== "archived").length,
    openTasks: input.counts.openTasks,
    blockedTasks: input.counts.blockedTasks,
    agentTasks: input.counts.agentTasks,
    userTasks: input.counts.userTasks,
    doneTasks: input.counts.doneTasks,
    nextDueAt: unfinished[0] ?? null,
    overdueProjects: overdueProjectsFrom(input.work.projects),
  };
}

const MODE_INSTRUCTIONS: Record<ResponsibilityDelegationMode, string> = {
  plan_with_me:
    "Plan this with me. Propose a plan and wait for my approval before you do any of the work.",
  prepare_i_decide:
    "Prepare this and let me decide. Do the preparation, then bring the decision back to me. Do not make the decision yourself.",
  handle_and_tell_me:
    "Handle this end to end. Tell me when it is done and what you did.",
  own_from_now_on:
    "Own this from now on as a standing duty. You now run this responsibility: set up whatever recurring routine it needs, file that routine under this responsibility, keep its metric current, and tell me what you set up.",
};

/** Pure: the task description a delegation creates. */
export function buildDelegationDescription(input: {
  mode: ResponsibilityDelegationMode;
  responsibility: { id: string; title: string; standard: string | null; metricName?: string | null; metricKind?: string | null; metricUnit?: string | null };
  instructions?: string | null;
}) {
  const lines = [`**How to work:** ${MODE_INSTRUCTIONS[input.mode]}`, ""];
  lines.push(`**Responsibility:** ${input.responsibility.title}`);
  if (input.responsibility.standard?.trim()) {
    lines.push(`**What good looks like:** ${input.responsibility.standard.trim()}`);
  }
  if (input.mode === "own_from_now_on") {
    lines.push(
      "",
      `To file a routine under this responsibility, link it with \`POST /api/responsibilities/${input.responsibility.id}/links\` and \`{ "routineId": "<routine id>" }\`.`,
    );
    if (input.responsibility.metricName?.trim()) {
      lines.push(
        resolveResponsibilityMetricKind(input.responsibility.metricKind, input.responsibility.metricUnit) === "yes_no"
          ? `To report whether "${input.responsibility.metricName.trim()}" holds, send \`PATCH /api/responsibilities/${input.responsibility.id}\` with \`{ "metricCurrent": true }\` or \`{ "metricCurrent": false }\`.`
          : `To report the latest ${input.responsibility.metricName.trim()}, send \`PATCH /api/responsibilities/${input.responsibility.id}\` with \`{ "metricCurrent": <number> }\`.`,
      );
    }
  }
  if (input.instructions?.trim()) {
    lines.push("", "**Instructions:**", "", input.instructions.trim());
  }
  return lines.join("\n");
}

type BarCompletenessRow = ResponsibilityBarRow;

/**
 * The fields a responsibility needs before it can be active, by API field
 * name; they depend on its template. With `barOptional` (a person's own
 * responsibility) a row with no metric at all needs nothing, while any part
 * of a metric still needs the whole bar.
 */
export function missingForActive(row: BarCompletenessRow, options: { barOptional?: boolean } = {}) {
  return responsibilityBarMissingForActive(row, options);
}

const ACTIVE_NEEDS: Record<ResponsibilityMetricKind, string> = {
  volume: "a metric name and a target",
  percentage: "a metric name and a target",
  yes_no: "a metric name (the statement that should be true)",
  range: "a metric name and a low and a high bound",
};

function assertCanBeActive(row: BarCompletenessRow, options: { barOptional?: boolean } = {}) {
  const missing = missingForActive(row, options);
  if (missing.length > 0) {
    const kind = resolveResponsibilityMetricKind(row.metricKind, row.metricUnit);
    throw unprocessable(
      options.barOptional
        ? `A responsibility with a metric needs its bar (standard) and ${ACTIVE_NEEDS[kind]} before it can be active; finish the bar or clear the metric`
        : `A responsibility needs its bar (standard) and ${ACTIVE_NEEDS[kind]} before it can be active`,
      { missing, metricKind: kind },
    );
  }
}

const BAR_INPUT_KEYS = ["metricKind", "metricName", "metricUnit", "metricDirection", "metricTarget", "metricLow", "metricHigh"] as const;

/**
 * The bar columns a patch writes, merged with the row and checked against the
 * template's rules. Changing the template clears the inputs the new template
 * does not use, and the reading unless the patch sends one. A patch that
 * touches no bar input leaves an existing row exactly as it is.
 *
 * With `allowClear` (a person's own responsibility), a patch that only
 * empties metric inputs and leaves no metric behind clears the metric
 * entirely, even on an active row: it reads as not measured again. A patch
 * that sends any metric value still has to leave a whole bar.
 */
export function mergeBarPatch(existing: ResponsibilityRow, patch: UpdateResponsibility, opts: { complete: boolean; allowClear?: boolean }) {
  const currentKind = resolveResponsibilityMetricKind(existing.metricKind, existing.metricUnit);
  const touchesBar = BAR_INPUT_KEYS.some((key) => patch[key] !== undefined);
  const kind = patch.metricKind ?? currentKind;
  const kindChanged = patch.metricKind !== undefined && patch.metricKind !== currentKind;
  const template = RESPONSIBILITY_BAR_TEMPLATES[kind];
  const keep = <T,>(field: ResponsibilityBarField, sent: T | undefined, stored: T) =>
    sent !== undefined ? sent : kindChanged && !template.fields.includes(field) ? null : stored;
  const merged = {
    metricKind: kind,
    metricUnit: keep("metricUnit", patch.metricUnit, existing.metricUnit),
    metricDirection: keep("metricDirection", patch.metricDirection, existing.metricDirection as ResponsibilityMetricDirection | null),
    metricTarget: keep("metricTarget", patch.metricTarget, numberOrNull(existing.metricTarget)),
    metricLow: keep("metricLow", patch.metricLow, numberOrNull(existing.metricLow)),
    metricHigh: keep("metricHigh", patch.metricHigh, numberOrNull(existing.metricHigh)),
  };
  const reading = patch.metricCurrent !== undefined ? patch.metricCurrent
    : kindChanged ? null : numberOrNull(existing.metricCurrent);
  const clearing = !!opts.allowClear && touchesBar
    && BAR_INPUT_KEYS.every((key) => patch[key] === undefined || patch[key] === null)
    && !responsibilityHasMetric({
      metricName: patch.metricName !== undefined ? patch.metricName : existing.metricName,
      metricTarget: merged.metricTarget,
      metricLow: merged.metricLow,
      metricHigh: merged.metricHigh,
      metricCurrent: typeof reading === "boolean" ? Number(reading) : reading,
    });
  if (clearing) {
    const set: Partial<typeof responsibilities.$inferInsert> = {
      metricKind: null,
      metricName: null,
      metricUnit: null,
      metricDirection: null,
      metricTarget: null,
      metricLow: null,
      metricHigh: null,
    };
    return { kind: currentKind, set, kindChanged: false, cleared: true };
  }
  if (touchesBar || patch.metricCurrent !== undefined) {
    const issues = responsibilityBarIssues(
      // Only check what this patch changes when the bar itself is untouched:
      // a reading on a row saved before templates existed must still land.
      touchesBar ? { ...merged, metricCurrent: reading } : { metricKind: kind, metricCurrent: patch.metricCurrent },
      { complete: opts.complete && touchesBar },
    );
    if (issues.length > 0) {
      throw unprocessable(issues.map((issue) => issue.message).join("; "), { metricKind: kind, issues });
    }
  }
  if (!touchesBar) return { kind, set: {} as Partial<typeof responsibilities.$inferInsert>, kindChanged: false, cleared: false };
  // A percentage's unit is always "%"; volume and percentage default to at_least.
  const normalized = normalizeResponsibilityBar({
    standard: "-",
    metricName: patch.metricName ?? existing.metricName ?? "-",
    ...merged,
  });
  const set: Partial<typeof responsibilities.$inferInsert> = {
    metricKind: kind,
    metricUnit: normalized.metricUnit,
    metricDirection: normalized.metricDirection,
    metricTarget: normalized.metricTarget,
    metricLow: normalized.metricLow,
    metricHigh: normalized.metricHigh,
  };
  if (patch.metricName !== undefined) set.metricName = patch.metricName;
  if (kindChanged && patch.metricCurrent === undefined && existing.metricCurrent !== null) {
    set.metricCurrent = null;
    set.metricUpdatedAt = null;
  }
  return { kind, set, kindChanged, cleared: false };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function responsibilityService(db: Db, deps: { routines?: ReturnType<typeof routineService> } = {}) {
  const issuesSvc = issueService(db);
  const areasSvc = responsibilityAreaService(db);
  // Made on first use: only the detail read asks the routines module (for each routine's last run).
  let routinesSvc = deps.routines;
  const routinesModule = () => (routinesSvc ??= routineService(db));

  async function getRow(id: string) {
    return db.select().from(responsibilities).where(eq(responsibilities.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function isCompanyMember(companyId: string, userId: string) {
    return db.select({ id: companyMemberships.id }).from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1)
      .then((rows) => rows.length > 0);
  }

  /**
   * (responsibility, task) pairs: a task is under a responsibility when it is
   * linked to it or its project is. Each pair appears once.
   */
  function memberIssues(ids: readonly string[], scope: ResponsibilityReadScope) {
    return db.selectDistinct({ responsibilityId: responsibilityLinks.responsibilityId, issueId: issues.id })
      .from(responsibilityLinks)
      .innerJoin(issues, and(
        eq(issues.companyId, responsibilityLinks.companyId),
        or(eq(issues.id, responsibilityLinks.issueId), eq(issues.projectId, responsibilityLinks.projectId)),
      ))
      .where(and(inArray(responsibilityLinks.responsibilityId, [...ids]), isNull(issues.hiddenAt), scope.issueReadCondition))
      .as("member_issues");
  }

  /** (responsibility, routine) pairs, linked directly or through a linked project. */
  function memberRoutines(ids: readonly string[]) {
    return db.selectDistinct({ responsibilityId: responsibilityLinks.responsibilityId, routineId: routines.id })
      .from(responsibilityLinks)
      .innerJoin(routines, and(
        eq(routines.companyId, responsibilityLinks.companyId),
        or(eq(routines.id, responsibilityLinks.routineId), eq(routines.projectId, responsibilityLinks.projectId)),
      ))
      .where(inArray(responsibilityLinks.responsibilityId, [...ids]))
      .as("member_routines");
  }

  const lastRunStatus = sql<string | null>`(select rr.status from ${routineRuns} rr where rr.routine_id = ${routines.id} order by rr.triggered_at desc limit 1)`;
  const lastRunAt = sql<string | null>`(select rr.triggered_at from ${routineRuns} rr where rr.routine_id = ${routines.id} order by rr.triggered_at desc limit 1)`;
  const nextRunAt = sql<string | null>`(select min(rt.next_run_at) from ${routineTriggers} rt where rt.routine_id = ${routines.id} and rt.enabled and not rt.archived)`;

  /** Rollups for many responsibilities in a fixed number of aggregate queries. */
  async function computeRollups(
    rows: ReadonlyArray<ResponsibilityRow>,
    scope: ResponsibilityReadScope,
  ): Promise<Map<string, ResponsibilityRollup>> {
    const result = new Map<string, ResponsibilityRollup>();
    if (rows.length === 0) return result;
    const ids = rows.map((row) => row.id);
    const tasks = memberIssues(ids, scope);
    const memberRoutineRows = memberRoutines(ids);

    const [taskCounts, openByAssignee, blocked, projectRows, routineRows] = await Promise.all([
      db.select({
        responsibilityId: tasks.responsibilityId,
        totalTasks: sql<number>`count(*)::int`,
        openTasks: sql<number>`(count(*) filter (where ${OPEN_TASK}))::int`,
        blockedTasks: sql<number>`(count(*) filter (where ${issues.status} = 'blocked'))::int`,
        agentTasks: sql<number>`(count(*) filter (where ${OPEN_TASK} and ${issues.assigneeAgentId} is not null))::int`,
        userTasks: sql<number>`(count(*) filter (where ${OPEN_TASK} and ${issues.assigneeAgentId} is null))::int`,
        doneTasks: sql<number>`(count(*) filter (where ${issues.status} = 'done'))::int`,
        completedRecently: sql<number>`(count(*) filter (where ${issues.status} = 'done' and ${issues.completedAt} >= now() - make_interval(days => ${RESPONSIBILITY_RECENTLY_COMPLETED_DAYS})))::int`,
      }).from(tasks)
        .innerJoin(issues, eq(issues.id, tasks.issueId))
        .groupBy(tasks.responsibilityId),
      db.select({
        responsibilityId: tasks.responsibilityId,
        agentId: issues.assigneeAgentId,
        userId: sql<string | null>`case when ${issues.assigneeAgentId} is null then ${issues.assigneeUserId} end`,
        agentName: agents.name,
        userName: authUsers.name,
        count: sql<number>`count(*)::int`,
      }).from(tasks)
        .innerJoin(issues, eq(issues.id, tasks.issueId))
        .leftJoin(agents, eq(agents.id, issues.assigneeAgentId))
        .leftJoin(authUsers, sql`${authUsers.id} = ${issues.assigneeUserId} and ${issues.assigneeAgentId} is null`)
        .where(OPEN_TASK)
        .groupBy(tasks.responsibilityId, issues.assigneeAgentId, sql`case when ${issues.assigneeAgentId} is null then ${issues.assigneeUserId} end`, agents.name, authUsers.name),
      db.select({ responsibilityId: tasks.responsibilityId, id: issues.id, title: issues.title })
        .from(tasks)
        .innerJoin(issues, eq(issues.id, tasks.issueId))
        .where(eq(issues.status, "blocked"))
        .orderBy(desc(issues.updatedAt), asc(issues.id)),
      db.select({
        responsibilityId: responsibilityLinks.responsibilityId,
        id: projects.id,
        name: projects.name,
        status: projects.status,
        targetDate: sql<string | null>`to_char(${projects.targetDate}, 'YYYY-MM-DD')`,
        daysUntil: sql<number | null>`(${projects.targetDate} - current_date)::int`,
        archivedAt: projects.archivedAt,
      }).from(responsibilityLinks)
        .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
        .where(and(inArray(responsibilityLinks.responsibilityId, ids), scope.projectReadCondition))
        .orderBy(asc(projects.name)),
      db.select({
        responsibilityId: memberRoutineRows.responsibilityId,
        id: routines.id,
        title: routines.title,
        status: routines.status,
        lastRunStatus,
        lastRunAt,
        nextRunAt,
      }).from(memberRoutineRows)
        .innerJoin(routines, eq(routines.id, memberRoutineRows.routineId))
        .where(sql`${routines.status} <> 'archived'`),
    ]);

    const counts = new Map<string, RollupCounts>();
    const work = new Map<string, ResponsibilityWorkInput>();
    const workFor = (id: string) => {
      const existing = work.get(id);
      if (existing) return existing;
      const created = emptyWork();
      work.set(id, created);
      return created;
    };
    for (const row of taskCounts) {
      counts.set(row.responsibilityId, {
        totalTasks: Number(row.totalTasks),
        openTasks: Number(row.openTasks),
        blockedTasks: Number(row.blockedTasks),
        agentTasks: Number(row.agentTasks),
        userTasks: Number(row.userTasks),
        doneTasks: Number(row.doneTasks),
      });
      workFor(row.responsibilityId).completedRecently = Number(row.completedRecently);
    }
    for (const row of openByAssignee) {
      workFor(row.responsibilityId).openByAssignee.push({
        agentId: row.agentId,
        userId: row.userId,
        name: row.agentId ? row.agentName : row.userName,
        count: Number(row.count),
      });
    }
    for (const row of blocked) workFor(row.responsibilityId).blockedTasks.push({ id: row.id, title: row.title });
    for (const row of projectRows) {
      workFor(row.responsibilityId).projects.push({
        id: row.id,
        name: row.name,
        status: row.status,
        targetDate: row.targetDate,
        daysUntil: row.daysUntil === null ? null : Number(row.daysUntil),
        archived: row.archivedAt !== null,
      });
    }
    for (const row of routineRows) {
      workFor(row.responsibilityId).routines.push({
        id: row.id,
        title: row.title,
        status: row.status,
        lastRunStatus: row.lastRunStatus,
        lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
        nextRunAt: row.nextRunAt ? new Date(row.nextRunAt) : null,
      });
    }
    const now = new Date();
    for (const row of rows) {
      result.set(row.id, buildResponsibilityRollup({
        responsibilityId: row.id,
        metric: {
          kind: row.metricKind,
          name: row.metricName,
          unit: row.metricUnit,
          target: numberOrNull(row.metricTarget),
          low: numberOrNull(row.metricLow),
          high: numberOrNull(row.metricHigh),
          current: numberOrNull(row.metricCurrent),
          direction: (row.metricDirection ?? null) as ResponsibilityMetricDirection | null,
          updatedAt: row.metricUpdatedAt,
        },
        healthOverride: row.healthOverride,
        counts: counts.get(row.id) ?? emptyCounts(),
        work: work.get(row.id) ?? emptyWork(),
        now,
      }));
    }
    return result;
  }

  async function withRollups(rows: ResponsibilityRow[], scope: ResponsibilityReadScope): Promise<ResponsibilityWithRollup[]> {
    const rollups = await computeRollups(rows, scope);
    return rows.map((row) => ({ ...toResponsibility(row), rollup: rollups.get(row.id)! }));
  }

  /** Distinct open tasks across responsibilities: a task under two counts once. */
  async function distinctTaskTotals(ids: readonly string[], scope: ResponsibilityReadScope) {
    if (ids.length === 0) return { openTasks: 0, agentTasks: 0, userTasks: 0, blockedTasks: 0 };
    const tasks = memberIssues(ids, scope);
    const [row] = await db.select({
      openTasks: sql<number>`(count(distinct ${issues.id}) filter (where ${OPEN_TASK}))::int`,
      blockedTasks: sql<number>`(count(distinct ${issues.id}) filter (where ${issues.status} = 'blocked'))::int`,
      agentTasks: sql<number>`(count(distinct ${issues.id}) filter (where ${OPEN_TASK} and ${issues.assigneeAgentId} is not null))::int`,
      userTasks: sql<number>`(count(distinct ${issues.id}) filter (where ${OPEN_TASK} and ${issues.assigneeAgentId} is null))::int`,
    }).from(tasks).innerJoin(issues, eq(issues.id, tasks.issueId));
    return {
      openTasks: Number(row?.openTasks ?? 0),
      agentTasks: Number(row?.agentTasks ?? 0),
      userTasks: Number(row?.userTasks ?? 0),
      blockedTasks: Number(row?.blockedTasks ?? 0),
    };
  }

  /** Distinct unfinished projects linked under responsibilities: a project under two counts once. */
  async function distinctProjectTotals(ids: readonly string[], scope: ResponsibilityReadScope) {
    if (ids.length === 0) return { projects: 0, lateProjects: 0 };
    const [row] = await db.select({
      projects: sql<number>`(count(distinct ${projects.id}))::int`,
      lateProjects: sql<number>`(count(distinct ${projects.id}) filter (where ${projects.targetDate} < current_date))::int`,
    })
      .from(responsibilityLinks)
      .innerJoin(projects, eq(projects.id, responsibilityLinks.projectId))
      .where(and(inArray(responsibilityLinks.responsibilityId, [...ids]), UNFINISHED_PROJECT, scope.projectReadCondition));
    return { projects: Number(row?.projects ?? 0), lateProjects: Number(row?.lateProjects ?? 0) };
  }

  /** Company-wide unfinished projects, open tasks and active routines under no live responsibility. */
  async function looseWork(companyId: string, scope: ResponsibilityReadScope): Promise<ResponsibilityLooseWork> {
    const liveLink = (column: SQL) => sql`exists (
      select 1 from ${responsibilityLinks} ll
      join ${responsibilities} lr on lr.id = ll.responsibility_id
      where ${column} and lr.status in ${LIVE_STATUS_SQL})`;
    const projectLoose = sql`not ${liveLink(sql`ll.project_id = ${projects.id}`)}`;
    const issueLoose = sql`not ${liveLink(sql`ll.issue_id = ${issues.id}`)}
      and (${issues.projectId} is null or not ${liveLink(sql`ll.project_id = ${issues.projectId}`)})`;
    const routineLoose = sql`not ${liveLink(sql`ll.routine_id = ${routines.id}`)}
      and (${routines.projectId} is null or not ${liveLink(sql`ll.project_id = ${routines.projectId}`)})`;
    const projectWhere = and(eq(projects.companyId, companyId), UNFINISHED_PROJECT, scope.projectReadCondition, projectLoose);
    const issueWhere = and(eq(issues.companyId, companyId), OPEN_TASK, isNull(issues.hiddenAt), scope.issueReadCondition, issueLoose);
    const routineWhere = and(eq(routines.companyId, companyId), eq(routines.status, "active"), routineLoose);
    const [projectCount, projectList, taskCount, taskList, routineCount, routineList] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(projects).where(projectWhere),
      db.select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        targetDate: projects.targetDate,
        leadAgentId: projects.leadAgentId,
        archivedAt: projects.archivedAt,
      }).from(projects).where(projectWhere)
        .orderBy(sql`${projects.targetDate} asc nulls last`, asc(projects.name), asc(projects.id))
        .limit(RESPONSIBILITY_LOOSE_LIST_LIMIT),
      db.select({ count: sql<number>`count(*)::int` }).from(issues).where(issueWhere),
      db.select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
      }).from(issues).where(issueWhere)
        .orderBy(desc(issues.updatedAt), asc(issues.id))
        .limit(RESPONSIBILITY_LOOSE_TASK_LIMIT),
      db.select({ count: sql<number>`count(*)::int` }).from(routines).where(routineWhere),
      db.select({
        id: routines.id,
        title: routines.title,
        status: routines.status,
        assigneeAgentId: routines.assigneeAgentId,
        projectId: routines.projectId,
      }).from(routines).where(routineWhere)
        .orderBy(asc(routines.title), asc(routines.id))
        .limit(RESPONSIBILITY_LOOSE_LIST_LIMIT),
    ]);
    return {
      projectCount: Number(projectCount[0]?.count ?? 0),
      openTaskCount: Number(taskCount[0]?.count ?? 0),
      routineCount: Number(routineCount[0]?.count ?? 0),
      projects: projectList.map((project) => ({ ...project, status: project.status as ProjectStatus })),
      tasks: taskList.map((task) => ({ ...task, status: task.status as IssueStatus })),
      routines: routineList.map((routine) => ({ ...routine, status: routine.status as RoutineStatus })),
    };
  }

  async function assertTargetInCompany(
    companyId: string,
    target: ResponsibilityLinkTarget,
    scope: ResponsibilityReadScope,
  ) {
    if (target.kind === "project") {
      const [row] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.id, target.id), eq(projects.companyId, companyId), scope.projectReadCondition))
        .limit(1);
      if (!row) throw notFound("Project not found");
      return row;
    }
    if (target.kind === "issue") {
      const [row] = await db.select({ id: issues.id, projectId: issues.projectId }).from(issues)
        .where(and(eq(issues.id, target.id), eq(issues.companyId, companyId), isNull(issues.hiddenAt), scope.issueReadCondition))
        .limit(1);
      if (!row) throw notFound("Task not found");
      return row;
    }
    const [row] = await db.select({ id: routines.id, projectId: routines.projectId }).from(routines)
      .where(and(eq(routines.id, target.id), eq(routines.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Routine not found");
    return row;
  }

  async function assertAreaUsable(companyId: string, areaId: string, database: Db | DbTransaction = db) {
    const area = await areasSvc.getInCompany(companyId, areaId, database);
    if (!area) throw notFound("Area not found");
    if (area.status === "archived") throw unprocessable("That area is archived; restore it or choose another area");
    return area;
  }

  async function assertAgentInCompany(companyId: string, agentId: string) {
    const [row] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("Agent not found");
  }

  /** File a target under a responsibility inside `tx`. Idempotent; other responsibilities are untouched. */
  async function linkInTx(
    tx: DbTransaction,
    row: ResponsibilityRow,
    target: ResponsibilityLinkTarget,
  ): Promise<{ link: ResponsibilityLink; created: boolean }> {
    const values = {
      companyId: row.companyId,
      responsibilityId: row.id,
      projectId: target.kind === "project" ? target.id : null,
      issueId: target.kind === "issue" ? target.id : null,
      routineId: target.kind === "routine" ? target.id : null,
    };
    const [inserted] = await tx.insert(responsibilityLinks).values(values).onConflictDoNothing().returning();
    if (inserted) return { link: toLink(inserted), created: true };
    const column = target.kind === "project" ? responsibilityLinks.projectId
      : target.kind === "issue" ? responsibilityLinks.issueId
        : responsibilityLinks.routineId;
    const [existing] = await tx.select().from(responsibilityLinks)
      .where(and(eq(responsibilityLinks.responsibilityId, row.id), eq(column, target.id)));
    if (!existing) throw new Error("Responsibility link insert conflicted but no link exists");
    return { link: toLink(existing), created: false };
  }

  /** Inside `tx`: when the row is active and its area is proposed, the area becomes active. */
  async function activateAreaFor(tx: DbTransaction, row: ResponsibilityRow): Promise<ResponsibilityArea | null> {
    if (row.status !== "active" || !row.areaId) return null;
    return areasSvc.activateIfProposed(tx, row.companyId, row.areaId);
  }

  /** Agent rule for an active responsibility: it runs it, or is assigned a member task or routine. */
  async function agentWorksOn(row: ResponsibilityRow, agentId: string, scope: ResponsibilityReadScope) {
    if (row.runByAgentId === agentId) return true;
    const tasks = memberIssues([row.id], scope);
    const memberRoutineRows = memberRoutines([row.id]);
    const [task] = await db.select({ id: issues.id }).from(tasks)
      .innerJoin(issues, eq(issues.id, tasks.issueId))
      .where(eq(issues.assigneeAgentId, agentId))
      .limit(1);
    if (task) return true;
    const [routine] = await db.select({ id: routines.id }).from(memberRoutineRows)
      .innerJoin(routines, eq(routines.id, memberRoutineRows.routineId))
      .where(and(eq(routines.assigneeAgentId, agentId), sql`${routines.status} <> 'archived'`))
      .limit(1);
    return Boolean(routine);
  }

  async function skillsFor(row: ResponsibilityRow, scope: ResponsibilityReadScope, actor: AuthorizationActor | undefined) {
    const tasks = memberIssues([row.id], scope);
    const memberRoutineRows = memberRoutines([row.id]);
    const [taskAgents, routineAgents, leadAgents] = await Promise.all([
      db.selectDistinct({ agentId: issues.assigneeAgentId }).from(tasks)
        .innerJoin(issues, eq(issues.id, tasks.issueId))
        .where(and(OPEN_TASK, isNotNull(issues.assigneeAgentId))),
      db.selectDistinct({ agentId: routines.assigneeAgentId }).from(memberRoutineRows)
        .innerJoin(routines, eq(routines.id, memberRoutineRows.routineId))
        .where(and(sql`${routines.status} <> 'archived'`, isNotNull(routines.assigneeAgentId))),
      db.selectDistinct({ agentId: projects.leadAgentId }).from(responsibilityLinks)
        .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
        .where(and(eq(responsibilityLinks.responsibilityId, row.id), scope.projectReadCondition, isNotNull(projects.leadAgentId))),
    ]);
    const agentIds = new Set<string>();
    if (row.runByAgentId) agentIds.add(row.runByAgentId);
    for (const entry of [...taskAgents, ...routineAgents, ...leadAgents]) if (entry.agentId) agentIds.add(entry.agentId);
    if (agentIds.size === 0) return [];
    const assigned = await companySkillService(db, { actor }).listAssignedToAgents(row.companyId, [...agentIds]);
    return assigned
      .filter((entry) => !PLUMBING_SKILL_KEYS.has(entry.skill.key))
      .map(({ skill, agentIds: holders }): ResponsibilitySkillSummary => ({
        id: skill.id,
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        tagline: skill.tagline,
        iconUrl: skill.iconUrl,
        color: skill.color,
        agentIds: holders,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  }

  async function artifactsFor(row: ResponsibilityRow, scope: ResponsibilityReadScope) {
    // No storage: text attachments come without a preview; documents and work products keep theirs.
    const artifactsSvc = companyArtifactsService(db);
    const membership = sql`(${issues.id} in (
        select l.issue_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.issue_id is not null
      ) or ${issues.projectId} in (
        select l.project_id from ${responsibilityLinks} l where l.responsibility_id = ${row.id} and l.project_id is not null
      ))`;
    const options = { issueConditions: [membership], readCondition: scope.issueReadCondition, excludeArtifactReviewDocuments: true };
    const first = await artifactsSvc.list(row.companyId, { limit: RESPONSIBILITY_DETAIL_ARTIFACT_LIMIT }, options);
    const artifacts: CompanyArtifact[] = first.artifacts;
    let total = artifacts.length;
    let cursor = first.nextCursor;
    while (cursor && total < RESPONSIBILITY_ARTIFACT_COUNT_LIMIT) {
      const page = await artifactsSvc.list(row.companyId, { limit: COMPANY_ARTIFACTS_MAX_LIMIT, cursor }, options);
      total += page.artifacts.length;
      cursor = page.nextCursor;
    }
    total = Math.min(total, RESPONSIBILITY_ARTIFACT_COUNT_LIMIT);
    return { artifacts, artifactsTotal: total, artifactsTruncated: total > artifacts.length };
  }

  return {
    getById: (id: string) => getRow(id),
    isCompanyMember,
    computeRollups,

    /**
     * The work under an owner's active responsibilities that the automation
     * read needs, with this module's membership rules (a task or routine is
     * under a responsibility when it or its project is linked; hidden and
     * unreadable tasks are left out): the responsibilities, their routines
     * (not archived), their tasks that are open or were completed since
     * `completedSince` (never cancelled), and which have anything linked at
     * all. Four queries, whatever the count.
     */
    async automationWork(
      companyId: string,
      ownerUserId: string,
      scope: ResponsibilityReadScope,
      completedSince: Date,
    ) {
      const rows = await db.select({ id: responsibilities.id, areaId: responsibilities.areaId, runByAgentId: responsibilities.runByAgentId })
        .from(responsibilities)
        .where(and(
          eq(responsibilities.companyId, companyId),
          eq(responsibilities.ownerUserId, ownerUserId),
          eq(responsibilities.status, "active"),
        ))
        .orderBy(asc(responsibilities.sortOrder), asc(responsibilities.createdAt), asc(responsibilities.id));
      if (rows.length === 0) return { responsibilities: rows, tasks: [], routines: [], linked: new Set<string>() };
      const ids = rows.map((row) => row.id);
      const tasks = memberIssues(ids, scope);
      const memberRoutineRows = memberRoutines(ids);
      const [taskRows, routineRows, linkedRows] = await Promise.all([
        db.select({
          responsibilityId: tasks.responsibilityId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          completedAt: issues.completedAt,
          updatedAt: issues.updatedAt,
        }).from(tasks)
          .innerJoin(issues, eq(issues.id, tasks.issueId))
          .where(or(
            OPEN_TASK,
            and(eq(issues.status, "done"), sql`coalesce(${issues.completedAt}, ${issues.updatedAt}) >= ${completedSince.toISOString()}::timestamptz`),
          )),
        db.select({ responsibilityId: memberRoutineRows.responsibilityId, routineId: memberRoutineRows.routineId })
          .from(memberRoutineRows)
          .innerJoin(routines, eq(routines.id, memberRoutineRows.routineId))
          .where(sql`${routines.status} <> 'archived'`),
        db.selectDistinct({ responsibilityId: responsibilityLinks.responsibilityId })
          .from(responsibilityLinks)
          .where(inArray(responsibilityLinks.responsibilityId, ids)),
      ]);
      return {
        responsibilities: rows,
        tasks: taskRows.map((task) => ({ ...task, status: task.status as IssueStatus })),
        routines: routineRows,
        linked: new Set(linkedRows.map((row) => row.responsibilityId)),
      };
    },

    async withRollup(row: ResponsibilityRow, scope: ResponsibilityReadScope): Promise<ResponsibilityWithRollup> {
      const rollups = await computeRollups([row], scope);
      return { ...toResponsibility(row), rollup: rollups.get(row.id)! };
    },

    async overview(
      companyId: string,
      ownerUserId: string,
      opts: { includeLetGo: boolean; scope: ResponsibilityReadScope },
    ): Promise<ResponsibilityOverview> {
      const statuses: ResponsibilityStatus[] = opts.includeLetGo
        ? ["active", "proposed", "let_go"]
        : ["active", "proposed"];
      const rows = await db.select().from(responsibilities)
        .where(and(
          eq(responsibilities.companyId, companyId),
          eq(responsibilities.ownerUserId, ownerUserId),
          inArray(responsibilities.status, statuses),
        ))
        .orderBy(asc(responsibilities.sortOrder), asc(responsibilities.createdAt), asc(responsibilities.id));
      const activeIds = rows.filter((row) => row.status === "active").map((row) => row.id);
      const referencedAreaIds = [...new Set(rows.map((row) => row.areaId).filter((id): id is string => id !== null))];
      const [all, distinct, distinctProjects, loose, areaRows] = await Promise.all([
        withRollups(rows, opts.scope),
        distinctTaskTotals(activeIds, opts.scope),
        distinctProjectTotals(activeIds, opts.scope),
        looseWork(companyId, opts.scope),
        areasSvc.listActiveAnd(companyId, referencedAreaIds),
      ]);
      const responsibilitiesList = all.filter((row) => row.status !== "proposed");
      const proposed = all.filter((row) => row.status === "proposed");
      const active = all.filter((row) => row.status === "active");
      const emptyByHealth = (): Record<ResponsibilityHealth, number> => ({ behind: 0, at_risk: 0, on_track: 0, not_measured: 0 });
      const byHealth = emptyByHealth();
      const areaCounts = new Map<string, { activeResponsibilities: number; byHealth: Record<ResponsibilityHealth, number> }>();
      for (const row of active) {
        byHealth[row.rollup.health] += 1;
        if (row.areaId) {
          const entry = areaCounts.get(row.areaId) ?? { activeResponsibilities: 0, byHealth: emptyByHealth() };
          entry.activeResponsibilities += 1;
          entry.byHealth[row.rollup.health] += 1;
          areaCounts.set(row.areaId, entry);
        }
      }
      const areas: ResponsibilityOverviewArea[] = areaRows.map((area) => ({
        ...area,
        ...(areaCounts.get(area.id) ?? { activeResponsibilities: 0, byHealth: emptyByHealth() }),
      }));
      return {
        ownerUserId,
        areas,
        responsibilities: responsibilitiesList,
        proposed,
        totals: { byHealth, ...distinct, ...distinctProjects },
        loose,
      };
    },

    async detail(
      row: ResponsibilityRow,
      scope: ResponsibilityReadScope,
      opts: { actor?: AuthorizationActor } = {},
    ): Promise<ResponsibilityDetail> {
      const limit = RESPONSIBILITY_DETAIL_TASK_LIMIT;
      const taskFields = {
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
      };
      const routineFields = {
        id: routines.id,
        title: routines.title,
        status: routines.status,
        assigneeAgentId: routines.assigneeAgentId,
        projectId: routines.projectId,
      };
      const openFirst = sql`case when ${OPEN_TASK} then 0 else 1 end`;
      const notDirectHere = (column: SQL) =>
        sql`not exists (select 1 from ${responsibilityLinks} direct_link where direct_link.responsibility_id = ${row.id} and ${column})`;
      const memberTasks = memberIssues([row.id], scope);
      const [
        rollups, area, projectRows, directRoutineRows, projectRoutineRows, directTaskRows, projectTaskRows, skills, artifacts, projectTaskCounts,
      ] = await Promise.all([
        computeRollups([row], scope),
        row.areaId ? areasSvc.getInCompany(row.companyId, row.areaId) : Promise.resolve(null),
        db.select({
          linkId: responsibilityLinks.id,
          id: projects.id,
          name: projects.name,
          status: projects.status,
          targetDate: projects.targetDate,
          leadAgentId: projects.leadAgentId,
          archivedAt: projects.archivedAt,
        }).from(responsibilityLinks)
          .innerJoin(projects, and(eq(projects.id, responsibilityLinks.projectId), eq(projects.companyId, responsibilityLinks.companyId)))
          .where(and(eq(responsibilityLinks.responsibilityId, row.id), scope.projectReadCondition))
          .orderBy(asc(projects.name)),
        db.select({ ...routineFields, linkId: responsibilityLinks.id }).from(responsibilityLinks)
          .innerJoin(routines, and(eq(routines.id, responsibilityLinks.routineId), eq(routines.companyId, responsibilityLinks.companyId)))
          .where(eq(responsibilityLinks.responsibilityId, row.id)),
        db.selectDistinct(routineFields).from(responsibilityLinks)
          .innerJoin(routines, and(eq(routines.projectId, responsibilityLinks.projectId), eq(routines.companyId, responsibilityLinks.companyId)))
          .where(and(eq(responsibilityLinks.responsibilityId, row.id), notDirectHere(sql`direct_link.routine_id = ${routines.id}`))),
        db.select({ ...taskFields, linkId: responsibilityLinks.id }).from(responsibilityLinks)
          .innerJoin(issues, and(eq(issues.id, responsibilityLinks.issueId), eq(issues.companyId, responsibilityLinks.companyId)))
          .where(and(eq(responsibilityLinks.responsibilityId, row.id), isNull(issues.hiddenAt), scope.issueReadCondition))
          .orderBy(openFirst, desc(issues.updatedAt), asc(issues.id))
          .limit(limit + 1),
        db.selectDistinct(taskFields).from(responsibilityLinks)
          .innerJoin(issues, and(eq(issues.projectId, responsibilityLinks.projectId), eq(issues.companyId, responsibilityLinks.companyId)))
          .where(and(
            eq(responsibilityLinks.responsibilityId, row.id),
            isNull(issues.hiddenAt),
            scope.issueReadCondition,
            notDirectHere(sql`direct_link.issue_id = ${issues.id}`),
          ))
          .orderBy(desc(issues.updatedAt), asc(issues.id))
          .limit(limit + 1),
        skillsFor(row, scope, opts.actor),
        artifactsFor(row, scope),
        // Each project's tasks the reader can see, done and not cancelled: one grouped query.
        db.select({
          projectId: issues.projectId,
          done: sql<number>`(count(*) filter (where ${issues.status} = 'done'))::int`,
          total: sql<number>`(count(*) filter (where ${issues.status} <> 'cancelled'))::int`,
        }).from(memberTasks)
          .innerJoin(issues, eq(issues.id, memberTasks.issueId))
          .where(isNotNull(issues.projectId))
          .groupBy(issues.projectId),
      ]);
      // How each routine's latest run went, from the routines module: a fixed number of queries, whatever the count.
      const routineIds = [...directRoutineRows, ...projectRoutineRows].map((routine) => routine.id);
      const routineFacts = routineIds.length > 0 ? await routinesModule().automationFacts(row.companyId, routineIds) : new Map();
      const lastRunOf = (id: string): ResponsibilityRoutineSummary["lastRun"] => routineFacts.get(id)?.lastRun ?? null;
      const progressByProject = new Map(projectTaskCounts.map((count) => [count.projectId, { done: Number(count.done), total: Number(count.total) }]));
      const progressOf = (id: string): ResponsibilityProjectSummary["progress"] => {
        const progress = progressByProject.get(id);
        return progress && progress.total > 0 ? progress : null;
      };
      const rollup = rollups.get(row.id)!;
      const isOpen = (status: string) => status !== "done" && status !== "cancelled";
      const tasks: ResponsibilityTaskSummary[] = [
        ...directTaskRows.map((task) => ({ ...task, status: task.status as IssueStatus, membership: "direct" as const })),
        ...projectTaskRows.map((task) => ({ ...task, status: task.status as IssueStatus, membership: "project" as const, linkId: null })),
      ].sort((a, b) => {
        const open = Number(!isOpen(a.status)) - Number(!isOpen(b.status));
        if (open !== 0) return open;
        const updated = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        return updated !== 0 ? updated : a.id.localeCompare(b.id);
      }).slice(0, limit);
      const routineList: ResponsibilityRoutineSummary[] = [
        ...directRoutineRows.map((routine) => ({ ...routine, status: routine.status as RoutineStatus, membership: "direct" as const, lastRun: lastRunOf(routine.id) })),
        ...projectRoutineRows.map((routine) => ({
          ...routine, status: routine.status as RoutineStatus, membership: "project" as const, linkId: null, lastRun: lastRunOf(routine.id),
        })),
      ].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      return {
        ...toResponsibility(row),
        rollup,
        area: area ? { id: area.id, title: area.title, status: area.status as ResponsibilityArea["status"] } : null,
        skills,
        ...artifacts,
        projects: projectRows.map((project) => ({ ...project, status: project.status as ProjectStatus, progress: progressOf(project.id) })),
        tasks,
        tasksTruncated: directTaskRows.length + projectTaskRows.length > limit,
        routines: routineList,
      };
    },

    /**
     * Create a responsibility. Board: `active` by default, with a whole bar
     * or none at all (the validator guarantees it; none reads as not
     * measured). Agent: always `proposed`, and always with its whole bar.
     * An active one under a proposed area activates that area.
     */
    async create(
      companyId: string,
      input: CreateResponsibility,
      actor: ResponsibilityCreateActor,
      ownerUserId: string,
    ): Promise<{ responsibility: ResponsibilityRow; activatedArea: ResponsibilityArea | null }> {
      if (actor.type === "agent") {
        // The route validates agents against `proposeResponsibilitySchema`; this keeps the rule for any other caller.
        assertCanBeActive({
          standard: input.standard ?? null,
          metricName: input.metricName ?? null,
          metricKind: input.metricKind ?? null,
          metricUnit: input.metricUnit ?? null,
          metricTarget: input.metricTarget ?? null,
          metricLow: input.metricLow ?? null,
          metricHigh: input.metricHigh ?? null,
        });
      }
      if (input.areaId) await assertAreaUsable(companyId, input.areaId);
      if (input.runByAgentId) await assertAgentInCompany(companyId, input.runByAgentId);
      const now = new Date();
      // The schema guarantees a metric is either whole or absent; without one
      // every metric column stays empty and the row reads as not measured.
      const metricName = input.metricName?.trim();
      const bar = metricName
        ? normalizeResponsibilityBar({
            ...input,
            standard: input.standard ?? "",
            metricName,
            metricKind: input.metricKind ?? resolveResponsibilityMetricKind(null, input.metricUnit),
          })
        : null;
      const reading = bar ? normalizeResponsibilityReading(input.metricCurrent ?? null) : null;
      const common = {
        companyId,
        ownerUserId,
        areaId: input.areaId ?? null,
        title: input.title,
        description: input.description ?? null,
        standard: input.standard?.trim() || null,
        metricKind: bar?.metricKind ?? null,
        metricName: bar?.metricName ?? null,
        metricUnit: bar?.metricUnit ?? null,
        metricTarget: bar?.metricTarget ?? null,
        metricLow: bar?.metricLow ?? null,
        metricHigh: bar?.metricHigh ?? null,
        metricCurrent: reading,
        metricDirection: bar?.metricDirection ?? null,
        metricUpdatedAt: reading !== null ? now : null,
        runByAgentId: input.runByAgentId ?? null,
        evidence: input.evidence ?? null,
        sortOrder: input.sortOrder ?? 0,
      };
      const values: typeof responsibilities.$inferInsert = actor.type === "agent"
        ? { ...common, status: "proposed", source: "onboarding", proposedByAgentId: actor.agentId, confirmedAt: null }
        : {
            ...common,
            status: input.status ?? "active",
            source: input.source ?? "manual",
            proposedByAgentId: null,
            confirmedAt: (input.status ?? "active") === "active" ? now : null,
          };
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(responsibilities).values(values).returning();
        // The first reading starts the metric's history.
        if (reading !== null) {
          await recordPrimaryReading(tx, row!, {
            value: reading,
            recordedAt: now,
            actor: actor.type === "agent" ? { agentId: actor.agentId } : { userId: actor.userId },
          });
        }
        const activatedArea = await activateAreaFor(tx, row!);
        return { responsibility: row!, activatedArea };
      });
    },

    agentWorksOn,

    /**
     * When each task under a responsibility was finished (completed, or last
     * updated when it has no completion time), for those finished since
     * `since`. Hidden and unreadable tasks are left out, as everywhere.
     */
    async finishedTaskTimes(row: ResponsibilityRow, scope: ResponsibilityReadScope, since: Date): Promise<Date[]> {
      const tasks = memberIssues([row.id], scope);
      const finishedAt = sql<string>`coalesce(${issues.completedAt}, ${issues.updatedAt})`;
      const rows = await db.select({ at: finishedAt }).from(tasks)
        .innerJoin(issues, eq(issues.id, tasks.issueId))
        .where(and(eq(issues.status, "done"), sql`${finishedAt} >= ${since.toISOString()}::timestamptz`));
      return rows.map((entry) => new Date(entry.at));
    },

    /**
     * The work under a responsibility as id subqueries, with this module's
     * membership rules, for reads other modules make about it (its recent
     * runs): the tasks a reader can see (linked, or in a linked project; never
     * hidden) and its routines (linked, or in a linked project).
     */
    memberWorkSubqueries(row: Pick<ResponsibilityRow, "id">, scope: ResponsibilityReadScope) {
      const tasks = memberIssues([row.id], scope);
      const memberRoutineRows = memberRoutines([row.id]);
      return {
        issueIds: db.select({ id: tasks.issueId }).from(tasks),
        routineIds: db.select({ id: memberRoutineRows.routineId }).from(memberRoutineRows),
      };
    },

    /**
     * `opts.readingAt` dates a reading in `metricCurrent` (the owner recording
     * a past reading through the metrics endpoint); every reading is also kept
     * in the metric's history unless `opts.recordHistory` is false (a
     * correction of a reading already there). A reading older than the one the
     * row shows, checked under the row lock, only joins the history
     * (`olderReading`), so concurrent reports cannot replace a newer number.
     * Only a plain reading is compared: a patch that also changes the bar
     * always takes the reading it supplies.
     */
    async update(
      existing: ResponsibilityRow,
      patch: UpdateResponsibility,
      actor: { type: "board"; userId?: string | null } | { type: "agent"; agentId: string; scope: ResponsibilityReadScope },
      opts: { readingAt?: Date; readingNote?: string | null; recordHistory?: boolean } = {},
    ): Promise<{ responsibility: ResponsibilityRow; activatedArea: ResponsibilityArea | null; olderReading: boolean }> {
      if (actor.type === "agent") {
        if (existing.status === "active") {
          const keys = Object.keys(patch);
          if (keys.length !== 1 || keys[0] !== "metricCurrent") {
            throw forbidden("On an active responsibility an agent may only report metricCurrent; a board user changes everything else");
          }
          if (!(await agentWorksOn(existing, actor.agentId, actor.scope))) {
            throw forbidden("Only the agent that runs this responsibility, or an agent assigned a task or routine under it, can report its metric");
          }
        } else if (existing.status !== "proposed") {
          throw forbidden("Agents can only edit responsibilities that are still proposed");
        } else if (patch.status !== undefined && patch.status !== "proposed" && patch.status !== "dismissed") {
          throw forbidden("Agents can only propose or dismiss a responsibility; a board user confirms it");
        }
      }
      if (patch.areaId) await assertAreaUsable(existing.companyId, patch.areaId);
      if (patch.runByAgentId) await assertAgentInCompany(existing.companyId, patch.runByAgentId);

      const nextStatus = patch.status ?? existing.status;
      // A person's responsibility may be active with no bar at all (it reads as
      // not measured); an agent never activates one, and its proposals keep their bar.
      const barOptional = actor.type === "board";
      const bar = mergeBarPatch(existing, patch, { complete: nextStatus === "active", allowClear: barOptional });
      const merged = {
        standard: patch.standard !== undefined ? patch.standard : existing.standard,
        metricName: bar.set.metricName !== undefined ? bar.set.metricName : patch.metricName !== undefined ? patch.metricName : existing.metricName,
        metricKind: bar.cleared ? null : bar.kind,
        metricUnit: bar.set.metricUnit !== undefined ? bar.set.metricUnit : existing.metricUnit,
        metricTarget: bar.set.metricTarget !== undefined ? bar.set.metricTarget : existing.metricTarget,
        metricLow: bar.set.metricLow !== undefined ? bar.set.metricLow : existing.metricLow,
        metricHigh: bar.set.metricHigh !== undefined ? bar.set.metricHigh : existing.metricHigh,
        metricCurrent: patch.metricCurrent !== undefined ? normalizeResponsibilityReading(patch.metricCurrent)
          : bar.set.metricCurrent !== undefined ? bar.set.metricCurrent : existing.metricCurrent,
      };
      const becomingActive = nextStatus === "active" && existing.status !== "active";
      const clearingOnActive = nextStatus === "active"
        && (patch.standard === null || patch.metricName === null || patch.metricTarget === null
          || patch.metricLow === null || patch.metricHigh === null || bar.kindChanged);
      if (becomingActive || clearingOnActive) assertCanBeActive(merged, { barOptional });

      const set: Partial<typeof responsibilities.$inferInsert> = { updatedAt: new Date(), ...bar.set };
      for (const key of [
        "title", "description", "standard", "evidence", "sortOrder", "healthOverride", "healthNote", "status",
        "areaId", "runByAgentId",
      ] as const) {
        if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key];
      }
      const readingAt = opts.readingAt ?? new Date();
      if (patch.metricCurrent !== undefined) {
        set.metricCurrent = normalizeResponsibilityReading(patch.metricCurrent);
        set.metricUpdatedAt = patch.metricCurrent === null ? null : readingAt;
      }
      if (patch.status === "active" && !existing.confirmedAt) set.confirmedAt = new Date();
      return db.transaction(async (tx) => {
        const [locked] = await tx.select().from(responsibilities)
          .where(and(eq(responsibilities.id, existing.id), eq(responsibilities.companyId, existing.companyId)))
          .for("update");
        if (!locked) throw notFound("Responsibility not found");
        // The bar may have changed since `existing` was read: check the patch against the row as it is now.
        if (BAR_INPUT_KEYS.some((key) => String(locked[key] ?? "") !== String(existing[key] ?? ""))) {
          mergeBarPatch(locked, patch, { complete: nextStatus === "active", allowClear: barOptional });
        }
        const plainReading = Object.entries(patch).every(([key, value]) => key === "metricCurrent" || value === undefined);
        const olderReading = plainReading && patch.metricCurrent !== undefined && patch.metricCurrent !== null
          && locked.metricCurrent !== null && locked.metricUpdatedAt !== null
          && new Date(locked.metricUpdatedAt).getTime() > readingAt.getTime();
        if (olderReading) {
          delete set.metricCurrent;
          delete set.metricUpdatedAt;
        }
        const [row] = await tx.update(responsibilities).set(set)
          .where(and(eq(responsibilities.id, existing.id), eq(responsibilities.companyId, existing.companyId)))
          .returning();
        if (!row) throw notFound("Responsibility not found");
        // A new template measures something else, and a cleared metric measures nothing: its history starts again.
        if (bar.kindChanged || bar.cleared) await archivePrimaryMirror(tx, row);
        if (patch.metricCurrent !== undefined && patch.metricCurrent !== null && opts.recordHistory !== false) {
          await recordPrimaryReading(tx, row, {
            value: normalizeResponsibilityReading(patch.metricCurrent),
            recordedAt: readingAt,
            actor: actor.type === "agent" ? { agentId: actor.agentId } : { userId: actor.userId ?? null },
            note: opts.readingNote ?? null,
          });
        }
        const activatedArea = await activateAreaFor(tx, row);
        return { responsibility: row, activatedArea, olderReading };
      });
    },

    /**
     * Inside `tx`: replace the bar with an accepted proposal. The reading is
     * the proposal's when it has one; otherwise the existing reading is kept
     * only when it measures the same thing (same template, metric name and
     * unit). The row must still be proposed or active.
     */
    async applyBarInTx(
      tx: DbTransaction,
      ref: { id: string; companyId: string },
      bar: ResponsibilityBarProposalBar,
      reading: number | null,
      /** Who the reading came from, for the metric's history. */
      readingBy: MetricActor = {},
    ): Promise<{ before: ResponsibilityRow; after: ResponsibilityRow }> {
      const [before] = await tx.select().from(responsibilities)
        .where(and(eq(responsibilities.id, ref.id), eq(responsibilities.companyId, ref.companyId)))
        .for("update");
      if (!before) throw notFound("Responsibility not found");
      if (before.status !== "proposed" && before.status !== "active") {
        throw conflict("This responsibility is no longer proposed or active, so its bar cannot change", {
          code: "responsibility_bar_responsibility_closed",
        });
      }
      const sameMetric = resolveResponsibilityMetricKind(before.metricKind, before.metricUnit) === bar.metricKind
        && (before.metricName ?? "").trim().toLowerCase() === bar.metricName.toLowerCase()
        && (before.metricUnit?.trim() || null) === bar.metricUnit;
      const now = new Date();
      const set: Partial<typeof responsibilities.$inferInsert> = {
        standard: bar.standard,
        metricKind: bar.metricKind,
        metricName: bar.metricName,
        metricUnit: bar.metricUnit,
        metricDirection: bar.metricDirection,
        metricTarget: bar.metricTarget,
        metricLow: bar.metricLow,
        metricHigh: bar.metricHigh,
        updatedAt: now,
      };
      if (reading !== null) {
        set.metricCurrent = reading;
        set.metricUpdatedAt = now;
      } else if (!sameMetric) {
        set.metricCurrent = null;
        set.metricUpdatedAt = null;
      }
      const [after] = await tx.update(responsibilities).set(set)
        .where(and(eq(responsibilities.id, ref.id), eq(responsibilities.companyId, ref.companyId)))
        .returning();
      if (!after) throw notFound("Responsibility not found");
      if (!sameMetric) await archivePrimaryMirror(tx, after);
      if (reading !== null) await recordPrimaryReading(tx, after, { value: reading, recordedAt: now, actor: readingBy });
      return { before, after };
    },

    async remove(existing: ResponsibilityRow) {
      const [row] = await db.delete(responsibilities)
        .where(and(eq(responsibilities.id, existing.id), eq(responsibilities.companyId, existing.companyId)))
        .returning();
      return row ? toResponsibility(row) : null;
    },

    getLink: (linkId: string) =>
      db.select().from(responsibilityLinks).where(eq(responsibilityLinks.id, linkId))
        .then((rows) => (rows[0] ? toLink(rows[0]) : null)),

    async link(row: ResponsibilityRow, target: ResponsibilityLinkTarget, scope: ResponsibilityReadScope) {
      await assertTargetInCompany(row.companyId, target, scope);
      return db.transaction((tx) => linkInTx(tx, row, target));
    },

    async unlink(row: ResponsibilityRow, linkId: string) {
      const [removed] = await db.delete(responsibilityLinks)
        .where(and(eq(responsibilityLinks.id, linkId), eq(responsibilityLinks.responsibilityId, row.id)))
        .returning();
      return removed ? toLink(removed) : null;
    },

    /**
     * The proposed and active responsibilities a project, task or routine is
     * under, directly or (for a task or routine) through its project. A
     * responsibility reached both ways is reported once, as `direct`.
     */
    async lookup(
      companyId: string,
      target: ResponsibilityLinkTarget,
      scope: ResponsibilityReadScope,
    ): Promise<ResponsibilityLinkLookupEntry[]> {
      const found: { id: string; projectId?: string | null } = await assertTargetInCompany(companyId, target, scope);
      const projectId: string | null = target.kind === "project" ? null : found.projectId ?? null;
      const column = target.kind === "project" ? responsibilityLinks.projectId
        : target.kind === "issue" ? responsibilityLinks.issueId
          : responsibilityLinks.routineId;
      const rows = await db.select({
        id: responsibilities.id,
        title: responsibilities.title,
        areaId: responsibilities.areaId,
        ownerUserId: responsibilities.ownerUserId,
        direct: sql<boolean>`${column} = ${target.id}`,
      }).from(responsibilityLinks)
        .innerJoin(responsibilities, eq(responsibilities.id, responsibilityLinks.responsibilityId))
        .where(and(
          eq(responsibilities.companyId, companyId),
          inArray(responsibilities.status, [...LIVE_STATUSES]),
          projectId
            ? or(eq(column, target.id), eq(responsibilityLinks.projectId, projectId))
            : eq(column, target.id),
        ))
        .orderBy(asc(responsibilities.title), asc(responsibilities.id));
      const byId = new Map<string, ResponsibilityLinkLookupEntry>();
      for (const row of rows) {
        const via = row.direct ? "direct" as const : "project" as const;
        const current = byId.get(row.id);
        if (current && current.via === "direct") continue;
        byId.set(row.id, { id: row.id, title: row.title, areaId: row.areaId, ownerUserId: row.ownerUserId, via });
      }
      return [...byId.values()];
    },

    /**
     * Create a task assigned to an agent and file it under the responsibility
     * in one transaction, through the issue service the task-create route uses.
     * `own_from_now_on` also makes the assignee the agent that runs the
     * responsibility. The route wakes the assignee and writes activity after
     * commit.
     */
    async delegate(
      row: ResponsibilityRow,
      input: DelegateResponsibility,
      actor: { userId: string; runId: string | null; identityContextId: string | null; authorizationActor: AuthorizationActor },
      scope: ResponsibilityReadScope,
    ) {
      if (input.projectId) await assertTargetInCompany(row.companyId, { kind: "project", id: input.projectId }, scope);
      const description = buildDelegationDescription({ mode: input.mode, responsibility: row, instructions: input.instructions });
      return db.transaction(async (tx) => {
        const issue = await issuesSvc.create(row.companyId, {
          title: input.title,
          description,
          status: "todo",
          priority: "medium",
          assigneeAgentId: input.assigneeAgentId,
          projectId: input.projectId ?? null,
          createdByUserId: actor.userId,
          createdByAgentId: null,
          trustExplicitResponsibleUserId: true,
          workspaceSelectionActor: actor.authorizationActor,
          originRunId: actor.runId,
          originIdentityContextId: actor.identityContextId,
          actorRunId: actor.runId,
        }, tx);
        const { link } = await linkInTx(tx, row, { kind: "issue", id: issue.id });
        let runByAgentId = row.runByAgentId;
        if (input.mode === "own_from_now_on" && row.runByAgentId !== input.assigneeAgentId) {
          await tx.update(responsibilities)
            .set({ runByAgentId: input.assigneeAgentId, updatedAt: new Date() })
            .where(and(eq(responsibilities.id, row.id), eq(responsibilities.companyId, row.companyId)));
          runByAgentId = input.assigneeAgentId;
        }
        return { issue, link, runByAgentId, runByAgentChanged: runByAgentId !== row.runByAgentId };
      });
    },
  };
}
