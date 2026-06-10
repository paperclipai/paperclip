import { and, asc, desc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";

export const PRODUCTIVITY_REVIEW_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.issueProductivityReview;
export const DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS = 6;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS = 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS = 6 * 60 * 60 * 1000;
export const PRODUCTIVITY_REVIEW_REPEAT_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const MAX_CANDIDATE_ISSUES = 250;
const MAX_RUNS_FOR_STREAK = 100;
const MAX_PARENT_WALK_DEPTH = 25;
export const PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX = "Productivity review evidence refreshed.";
// BLO-3281 AC2 hard floor: even if the detector scan cadence is faster
// than this, the refresh-evidence-comment path stays throttled at 5 min.
// Defends against the 2026-05-05 incident on BLO-3277 (14 refreshes in
// 6 minutes, ~30s apart) regardless of scheduler config.
export const PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Marker set on heartbeat-run contextSnapshot.source by routine dispatches; see
// queueIssueAssignmentWakeup callers in routines.ts (`contextSource: "routine.dispatch"`).
const ROUTINE_DISPATCH_CONTEXT_SOURCE = "routine.dispatch";

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type ProductivityReviewTrigger = "no_comment_streak" | "long_active_duration" | "high_churn";

type ProductivityReviewThresholds = {
  noCommentStreakRuns: number;
  longActiveMs: number;
  highChurnHourly: number;
  highChurnSixHours: number;
  resolvedSnoozeMs: number;
  escalationThreshold: number;
  escalationLookbackMs: number;
};

type ProductivityReviewEvidence = {
  trigger: ProductivityReviewTrigger;
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  noCommentStreak: number;
  totalRunCount: number;
  terminalRunCount: number;
  activeRunCount: number;
  runCountLastHour: number;
  runCountLastSixHours: number;
  commentCount: number;
  commentCountLastHour: number;
  commentCountLastSixHours: number;
  elapsedMs: number | null;
  latestRuns: HeartbeatRunRow[];
  latestComments: Array<typeof issueComments.$inferSelect>;
  costCents: number;
  usageSamples: Array<{ runId: string; usageJson: Record<string, unknown> | null }>;
  nextAction: string | null;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
  routineOnlySamplingWindow: boolean;
};

type MonitorScheduledSuppression = {
  trigger: "long_active_duration";
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  elapsedMs: number | null;
  monitorNextCheckAt: Date;
  monitorScheduledBy: string;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
};

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

const MONITOR_SCHEDULED_SUPPRESSION_ACTORS = new Set(["assignee", "board"]);

type ProductivityReviewServiceDeps = {
  enqueueWakeup?: EnqueueWakeup;
  beforeCreateOrUpdateReview?: (evidence: ProductivityReviewEvidence) => Promise<void> | void;
};

function productivityReviewFingerprint(sourceIssueId: string) {
  return `productivity-review:${sourceIssueId}`;
}

function productivityReviewEscalationFingerprint(sourceIssueId: string) {
  return `productivity-review-escalation:${sourceIssueId}`;
}

function issueRunScopeSql(issueId: string) {
  return or(
    eq(heartbeatRuns.contextIssueId, issueId),
    eq(heartbeatRuns.contextTaskId, issueId),
    eq(heartbeatRuns.contextTaskKey, issueId),
  );
}

function msToHuman(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h ${minutes % 60}m`;
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function truncateInline(value: string | null | undefined, max = 260) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isActiveProductivityReviewUniqueConflict(error: unknown) {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const maybe = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (
      maybe.code === "23505" &&
      (maybe.constraint === "issues_active_productivity_review_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_productivity_review_uq"))
    ) {
      return true;
    }
    if (!maybe.cause || maybe.cause === current) return false;
    current = maybe.cause;
  }
  return false;
}

function coerceDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function deliberateFutureMonitor(issue: IssueRow, now: Date) {
  const monitorNextCheckAt = coerceDate(issue.monitorNextCheckAt);
  const monitorScheduledBy = issue.monitorScheduledBy;
  if (!monitorNextCheckAt || monitorNextCheckAt.getTime() <= now.getTime()) return null;
  if (!monitorScheduledBy || !MONITOR_SCHEDULED_SUPPRESSION_ACTORS.has(monitorScheduledBy)) return null;
  return { monitorNextCheckAt, monitorScheduledBy };
}

function isMonitorScheduledSuppression(
  value: ProductivityReviewEvidence | MonitorScheduledSuppression,
): value is MonitorScheduledSuppression {
  return "monitorNextCheckAt" in value;
}

function isRoutineOriginRun(run: HeartbeatRunRow): boolean {
  const ctx = run.contextSnapshot;
  if (!ctx || typeof ctx !== "object") return false;
  return (ctx as Record<string, unknown>).source === ROUTINE_DISPATCH_CONTEXT_SOURCE;
}

function buildThresholds(overrides?: Partial<ProductivityReviewThresholds>): ProductivityReviewThresholds {
  return {
    noCommentStreakRuns: readPositiveInteger(
      overrides?.noCommentStreakRuns ?? DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
    ),
    longActiveMs: readPositiveInteger(
      overrides?.longActiveMs ?? DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
      DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
    ),
    highChurnHourly: readPositiveInteger(
      overrides?.highChurnHourly ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
    ),
    highChurnSixHours: readPositiveInteger(
      overrides?.highChurnSixHours ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
    ),
    resolvedSnoozeMs: readPositiveInteger(
      overrides?.resolvedSnoozeMs ?? DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
    ),
    escalationThreshold: readPositiveInteger(
      overrides?.escalationThreshold ?? DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD,
      DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD,
    ),
    escalationLookbackMs: readPositiveInteger(
      overrides?.escalationLookbackMs ?? DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS,
    ),
  };
}

function choosePrimaryTrigger(input: {
  noComment: boolean;
  longActive: boolean;
  highChurn: boolean;
}): ProductivityReviewTrigger | null {
  if (input.noComment) return "no_comment_streak";
  if (input.highChurn) return "high_churn";
  if (input.longActive) return "long_active_duration";
  return null;
}

function isSoftStopTrigger(trigger: ProductivityReviewTrigger) {
  return trigger === "no_comment_streak" || trigger === "high_churn";
}

function formatTrigger(trigger: ProductivityReviewTrigger) {
  if (trigger === "no_comment_streak") return "No-comment streak";
  if (trigger === "high_churn") return "High churn";
  return "Long active duration";
}

export function productivityReviewService(db: Db, deps?: ProductivityReviewServiceDeps) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function evaluateSourceReviewability(sourceIssue: IssueRow, sourceAgentId: string) {
    const current = await db
      .select({
        status: issues.status,
        hiddenAt: issues.hiddenAt,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(and(eq(issues.companyId, sourceIssue.companyId), eq(issues.id, sourceIssue.id)))
      .then((rows) => rows[0] ?? null);
    const status = current?.status ?? null;
    const reviewable = Boolean(
      current &&
        !current.hiddenAt &&
        !current.assigneeUserId &&
        current.assigneeAgentId === sourceAgentId &&
        ["todo", "in_progress"].includes(current.status) &&
        current.originKind !== PRODUCTIVITY_REVIEW_ORIGIN_KIND,
    );
    // BLO-6243: a source that has reached a terminal status (done/cancelled) — including via
    // a race between candidate selection and this recheck — is a post-terminal sweep artifact,
    // not a work-stoppage signal. Surface it distinctly so the caller can suppress + audit it.
    const terminal = status === "done" || status === "cancelled";
    return { reviewable, terminal, status };
  }

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  async function isProductivityReviewDescendant(issue: Pick<IssueRow, "companyId" | "parentId">) {
    let parentId = issue.parentId;
    let depth = 0;
    while (parentId && depth < MAX_PARENT_WALK_DEPTH) {
      const parent = await db
        .select({ id: issues.id, parentId: issues.parentId, originKind: issues.originKind })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, parentId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) return false;
      if (parent.originKind === PRODUCTIVITY_REVIEW_ORIGIN_KIND) return true;
      parentId = parent.parentId;
      depth += 1;
    }
    return false;
  }

  async function findOpenProductivityReview(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findLatestRefreshCommentAt(companyId: string, reviewIssueId: string) {
    return db
      .select({ createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.createdAt ?? null);
  }

  async function findRecentResolvedProductivityReview(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.resolvedSnoozeMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasRepeatedTerminalReviewsInBackoff(companyId: string, sourceIssueId: string, now: Date) {
    const cutoff = new Date(now.getTime() - PRODUCTIVITY_REVIEW_REPEAT_BACKOFF_MS);
    const count = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    return count >= 2;
  }

  async function countResolvedProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    lookbackMs: number,
    now: Date,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - lookbackMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
          isNull(issues.hiddenAt),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function findOpenProductivityReviewEscalation(companyId: string, sourceIssueId: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.productivityReviewEscalation),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function latestResolvedProductivityReviews(companyId: string, sourceIssueId: string, lookbackMs: number, now: Date) {
    const cutoff = new Date(now.getTime() - lookbackMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(5);
  }

  async function recordMonitorScheduledSuppression(suppression: MonitorScheduledSuppression) {
    const details = {
      source: "productivity_review.reconcile",
      sourceIssueId: suppression.sourceIssue.id,
      trigger: suppression.trigger,
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: suppression.monitorNextCheckAt.toISOString(),
      monitorScheduledBy: suppression.monitorScheduledBy,
      elapsedMs: suppression.elapsedMs,
    };
    await logActivity(db, {
      companyId: suppression.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: suppression.sourceIssue.assigneeAgentId,
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: suppression.sourceIssue.id,
      details,
    });
    logger.info(details, "productivity review long_active_duration suppressed by scheduled monitor");
  }

  async function closeOpenSuppressedMonitorReviews(now: Date, companyId?: string) {
    const reviewRows = await db
      .select()
      .from(issues)
      .where(
        and(
          companyId ? eq(issues.companyId, companyId) : undefined,
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const sourceIssueIds = [
      ...new Set(reviewRows.map((review) => review.originId).filter((id): id is string => Boolean(id))),
    ];
    const sourceIssueById = new Map<string, IssueRow>();
    for (const chunk of sourceIssueIds.length > 0 ? [sourceIssueIds] : []) {
      const sourceRows = await db
        .select()
        .from(issues)
        .where(inArray(issues.id, chunk));
      for (const source of sourceRows) sourceIssueById.set(source.id, source);
    }

    const reviewTriggerById = new Map<string, unknown>();
    const reviewIds = reviewRows.map((review) => review.id);
    for (const chunk of reviewIds.length > 0 ? [reviewIds] : []) {
      const triggerRows = await db
        .select({ entityId: activityLog.entityId, details: activityLog.details })
        .from(activityLog)
        .where(
          and(
            companyId ? eq(activityLog.companyId, companyId) : undefined,
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, chunk),
            inArray(activityLog.action, ["issue.productivity_review_created", "issue.productivity_review_updated"]),
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
      for (const row of triggerRows) {
        if (!reviewTriggerById.has(row.entityId)) reviewTriggerById.set(row.entityId, row.details?.trigger);
      }
    }

    let closed = 0;
    for (const review of reviewRows) {
      if (!review.originId) continue;
      const trigger = reviewTriggerById.get(review.id);
      if (trigger !== "long_active_duration") continue;
      const sourceIssue = sourceIssueById.get(review.originId) ?? null;
      if (!sourceIssue) continue;
      if (sourceIssue.companyId !== review.companyId) continue;
      const monitor = deliberateFutureMonitor(sourceIssue, now);
      if (!monitor) continue;

      await db
        .update(issues)
        .set({ status: "done", completedAt: now, updatedAt: now })
        .where(eq(issues.id, review.id));
      await logActivity(db, {
        companyId: review.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_suppressed_open_review_closed",
        entityType: "issue",
        entityId: review.id,
        agentId: review.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: sourceIssue.id,
          trigger: "long_active_duration",
          suppressedBy: "monitor_scheduled",
          monitorNextCheckAt: monitor.monitorNextCheckAt.toISOString(),
          monitorScheduledBy: monitor.monitorScheduledBy,
        },
      });
      closed += 1;
    }
    return closed;
  }

  async function countIssueRunsSince(companyId: string, agentId: string, issueId: string, since: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function countIssueCommentsSince(companyId: string, issueId: string, agentId: string, since?: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, agentId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          since ? sql`${issueComments.createdAt} >= ${since.toISOString()}::timestamptz` : undefined,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function collectEvidence(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ): Promise<ProductivityReviewEvidence | MonitorScheduledSuppression | null> {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const latestRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, sourceIssue.companyId),
          eq(heartbeatRuns.agentId, sourceAgent.id),
          issueRunScopeSql(sourceIssue.id),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_RUNS_FOR_STREAK);

    const runIds = latestRuns.map((run) => run.id);
    const commentRunIds = new Set<string>();
    if (runIds.length > 0) {
      const commentRows = await db
        .select({ createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            inArray(issueComments.createdByRunId, runIds),
          ),
        );
      for (const row of commentRows) {
        if (row.createdByRunId) commentRunIds.add(row.createdByRunId);
      }
    }

    const terminalRuns = latestRuns.filter((run) =>
      TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]),
    );
    let noCommentStreak = 0;
    for (const run of terminalRuns) {
      if (commentRunIds.has(run.id)) break;
      noCommentStreak += 1;
    }

    const [
      runCountLastHour,
      runCountLastSixHours,
      assigneeRunCommentCount,
      assigneeRunCommentCountLastHour,
      assigneeRunCommentCountLastSixHours,
      latestComments,
      costRow,
    ] = await Promise.all([
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, oneHourAgo),
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, sixHoursAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, oneHourAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, sixHoursAgo),
      db
        .select({ comment: issueComments })
        .from(issueComments)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            eq(issueComments.authorAgentId, sourceAgent.id),
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            issueRunScopeSql(sourceIssue.id),
          ),
        )
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(5)
        .then((rows) => rows.map((row) => row.comment)),
      db
        .select({ costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, sourceIssue.companyId), eq(costEvents.issueId, sourceIssue.id)))
        .then((rows) => rows[0] ?? { costCents: 0 }),
    ]);

    const activeRunCount = latestRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]),
    ).length;
    const activeStartedAt = sourceIssue.startedAt ?? sourceIssue.executionLockedAt ?? null;
    const elapsedMs = sourceIssue.status === "in_progress" && activeStartedAt
      ? Math.max(0, now.getTime() - activeStartedAt.getTime())
      : null;

    const noComment = noCommentStreak >= thresholds.noCommentStreakRuns;
    const longActive = elapsedMs !== null && elapsedMs >= thresholds.longActiveMs;
    const highChurn =
      runCountLastHour >= thresholds.highChurnHourly ||
      assigneeRunCommentCountLastHour >= thresholds.highChurnHourly ||
      runCountLastSixHours >= thresholds.highChurnSixHours ||
      assigneeRunCommentCountLastSixHours >= thresholds.highChurnSixHours;
    const trigger = choosePrimaryTrigger({ noComment, longActive, highChurn });
    if (!trigger) return null;

    const triggerReasons: string[] = [];
    if (noComment) triggerReasons.push(`${noCommentStreak} consecutive completed issue-linked runs had no run-created issue comment`);
    if (longActive) triggerReasons.push(`current active episode has lasted ${msToHuman(elapsedMs)}`);
    if (highChurn) {
      triggerReasons.push(
        `${runCountLastHour} runs/${assigneeRunCommentCountLastHour} assignee-run comments in 1h; ${runCountLastSixHours} runs/${assigneeRunCommentCountLastSixHours} assignee-run comments in 6h`,
      );
    }

    const routineOnlySamplingWindow = latestRuns.length > 0 && latestRuns.every(isRoutineOriginRun);

    const monitor = deliberateFutureMonitor(sourceIssue, now);
    if (trigger === "long_active_duration" && monitor) {
      return {
        trigger,
        triggerReasons,
        sourceIssue,
        sourceAgent,
        elapsedMs,
        monitorNextCheckAt: monitor.monitorNextCheckAt,
        monitorScheduledBy: monitor.monitorScheduledBy,
        thresholds,
        generatedAt: now,
      };
    }

    return {
      trigger,
      triggerReasons,
      sourceIssue,
      sourceAgent,
      noCommentStreak,
      totalRunCount: latestRuns.length,
      terminalRunCount: terminalRuns.length,
      activeRunCount,
      runCountLastHour,
      runCountLastSixHours,
      commentCount: assigneeRunCommentCount,
      commentCountLastHour: assigneeRunCommentCountLastHour,
      commentCountLastSixHours: assigneeRunCommentCountLastSixHours,
      elapsedMs,
      latestRuns: latestRuns.slice(0, 5),
      latestComments,
      costCents: costRow.costCents,
      usageSamples: latestRuns
        .filter((run) => run.usageJson)
        .slice(0, 3)
        .map((run) => ({ runId: run.id, usageJson: run.usageJson ?? null })),
      nextAction: latestRuns.find((run) => run.nextAction)?.nextAction ?? null,
      thresholds,
      generatedAt: now,
      routineOnlySamplingWindow,
    };
  }

  async function resolveReviewOwnerAgentId(sourceIssue: IssueRow, sourceAgent: AgentRow) {
    const candidateIds: string[] = [];
    if (sourceAgent.reportsTo) candidateIds.push(sourceAgent.reportsTo);
    if (sourceIssue.createdByAgentId) candidateIds.push(sourceIssue.createdByAgentId);
    if (sourceIssue.projectId) {
      const project = await db
        .select({ leadAgentId: projects.leadAgentId })
        .from(projects)
        .where(and(eq(projects.companyId, sourceIssue.companyId), eq(projects.id, sourceIssue.projectId)))
        .then((rows) => rows[0] ?? null);
      if (project?.leadAgentId) candidateIds.push(project.leadAgentId);
    }
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, sourceIssue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== sourceIssue.companyId || !isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(sourceIssue.companyId, candidate.id, {
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId ?? null,
      });
      if (!budgetBlock) return candidate.id;
    }
    return null;
  }

  async function resolveEscalationOwnerUserId(companyId: string) {
    const rows = await db
      .select({ userId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(
        sql`case when ${companyMemberships.membershipRole} = 'owner' then 0 when ${companyMemberships.membershipRole} = 'admin' then 1 else 2 end`,
        asc(companyMemberships.createdAt),
        asc(companyMemberships.id),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  function isProductivityReviewOptedOut(issue: IssueRow) {
    const policy = issue.executionPolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
    const monitor = (policy as Record<string, unknown>).monitor;
    if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
    return (monitor as Record<string, unknown>).productivityReviewDisabled === true;
  }

  function buildReviewMarkdown(evidence: ProductivityReviewEvidence, prefix: string) {
    const latestRuns = evidence.latestRuns.length > 0
      ? evidence.latestRuns.map((run) =>
        `- ${runUiLink(run, prefix)} \`${run.status}\` liveness \`${run.livenessState ?? "unknown"}\`, created ${run.createdAt.toISOString()}${run.nextAction ? `, next action: ${truncateInline(run.nextAction, 160)}` : ""}`,
      ).join("\n")
      : "- none";
    const latestComments = evidence.latestComments.length > 0
      ? evidence.latestComments.map((comment) =>
        `- ${comment.createdAt.toISOString()}${comment.createdByRunId ? ` run \`${comment.createdByRunId}\`` : ""}: ${truncateInline(comment.body)}`,
      ).join("\n")
      : "- none";
    const usage = evidence.usageSamples.length > 0
      ? evidence.usageSamples.map((sample) => `- \`${sample.runId}\`: \`${JSON.stringify(sample.usageJson).slice(0, 500)}\``).join("\n")
      : "- no usage payloads on sampled runs";
    return [
      "Paperclip detected an unusual productivity/progression pattern on an assigned issue.",
      "",
      "## Source",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Assigned agent: ${evidence.sourceAgent.name} (${evidence.sourceAgent.role})`,
      `- Primary trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Trigger reasons: ${evidence.triggerReasons.join("; ")}`,
      `- Generated at: ${evidence.generatedAt.toISOString()}`,
      "",
      "## Evidence",
      "",
      `- Total sampled issue-linked runs: ${evidence.totalRunCount}`,
      `- Terminal sampled runs: ${evidence.terminalRunCount}`,
      `- Active queued/running/scheduled runs: ${evidence.activeRunCount}`,
      `- No-comment completed-run streak: ${evidence.noCommentStreak}`,
      `- Current active elapsed time: ${msToHuman(evidence.elapsedMs)}`,
      `- Runs in rolling windows: ${evidence.runCountLastHour}/1h, ${evidence.runCountLastSixHours}/6h`,
      `- Assignee run-linked comments total/window: ${evidence.commentCount} total, ${evidence.commentCountLastHour}/1h, ${evidence.commentCountLastSixHours}/6h`,
      `- Cost events total: ${evidence.costCents} cents`,
      `- Current next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 500) : "none recorded"}`,
      "",
      "## Thresholds",
      "",
      `- No-comment streak: ${evidence.thresholds.noCommentStreakRuns} completed runs`,
      `- Long active duration: ${msToHuman(evidence.thresholds.longActiveMs)}`,
      `- High churn: ${evidence.thresholds.highChurnHourly}/1h or ${evidence.thresholds.highChurnSixHours}/6h runs/assignee-run comments`,
      `- Resolved-review snooze: ${msToHuman(evidence.thresholds.resolvedSnoozeMs)}`,
      "",
      "## Latest Runs",
      "",
      latestRuns,
      "",
      "## Latest Assignee Run Comments",
      "",
      latestComments,
      "",
      "## Usage Samples",
      "",
      usage,
      "",
      "## Manager Decision",
      "",
      "A \"Close as productive\" verdict requires at least ONE of the following concrete progress signals:",
      "- An assignee run-linked comment in the last 6h that contains a `Next action:` line",
      "- A non-stale PR/MR link in the source issue's evidence (created or updated in the last 24h)",
      "- A recent test result, artifact commit, or workspace deliverable in the last 6h",
      "",
      "If none of these signals is present, the correct verdict is one of:",
      "- Request decomposition (the work is too large for a single heartbeat issue and needs to be split)",
      "- Block with an unblock owner (the work needs human direction; name the gate)",
      "- Stop/cancel (the work is not delivering value and should be wound down)",
      "- Continue with a snooze window (only if the assignee has a clear next step but no surface evidence yet)",
    ].join("\n");
  }

  function buildRefreshComment(evidence: ProductivityReviewEvidence, prefix: string) {
    return [
      "Productivity review evidence refreshed.",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Reasons: ${evidence.triggerReasons.join("; ")}`,
      `- No-comment streak: ${evidence.noCommentStreak}`,
      `- Runs/assignee comments: ${evidence.runCountLastHour}/${evidence.commentCountLastHour} in 1h, ${evidence.runCountLastSixHours}/${evidence.commentCountLastSixHours} in 6h`,
      `- Next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 300) : "none recorded"}`,
    ].join("\n");
  }

  async function createOrUpdateReview(
    evidence: ProductivityReviewEvidence,
    opts: { prefix: string },
  ) {
    if (evidence.routineOnlySamplingWindow) {
      logger.info(
        {
          sourceIssueId: evidence.sourceIssue.id,
          sourceIssueIdentifier: evidence.sourceIssue.identifier,
          trigger: evidence.trigger,
          sampledRunCount: evidence.totalRunCount,
        },
        "productivity review skipped: source issue's sampling-window runs are 100% routine-origin",
      );
      return { kind: "skipped" as const, reviewIssueId: null };
    }

    const existing = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
    if (existing) {
      // BLO-3281 AC2: hard-floor refresh interval. Even when the
      // scheduler triggers a re-scan inside the 5-min window, we
      // skip the addComment so the review thread doesn't accumulate
      // ~identical "evidence refreshed" comments. The previous run
      // is reused as the {kind:"existing"} outcome.
      const lastRefreshAt = await findLatestRefreshCommentAt(
        evidence.sourceIssue.companyId,
        existing.id,
      );
      if (
        lastRefreshAt &&
        evidence.generatedAt.getTime() - lastRefreshAt.getTime() < PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS
      ) {
        logger.debug(
          {
            reviewIssueId: existing.id,
            sourceIssueId: evidence.sourceIssue.id,
            lastRefreshAt: lastRefreshAt.toISOString(),
            minIntervalMs: PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS,
          },
          "productivity review refresh throttled: previous refresh within hard-floor window",
        );
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }
      await issuesSvc.addComment(existing.id, buildRefreshComment(evidence, opts.prefix), {});
      await logActivity(db, {
        companyId: evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: existing.id,
        agentId: existing.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
          noCommentStreak: evidence.noCommentStreak,
          runCountLastHour: evidence.runCountLastHour,
          commentCountLastHour: evidence.commentCountLastHour,
        },
      });
      return { kind: "updated" as const, reviewIssueId: existing.id };
    }

    const ownerAgentId = await resolveReviewOwnerAgentId(evidence.sourceIssue, evidence.sourceAgent);
    let review: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      review = await issuesSvc.create(evidence.sourceIssue.companyId, {
        title: `Review productivity for ${evidence.sourceIssue.identifier ?? evidence.sourceIssue.title}`,
        description: buildReviewMarkdown(evidence, opts.prefix),
        status: "todo",
        priority: evidence.trigger === "long_active_duration" ? "medium" : "high",
        parentId: evidence.sourceIssue.id,
        projectId: evidence.sourceIssue.projectId,
        goalId: evidence.sourceIssue.goalId,
        billingCode: evidence.sourceIssue.billingCode,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        originId: evidence.sourceIssue.id,
        originFingerprint: productivityReviewFingerprint(evidence.sourceIssue.id),
        requestDepth: clampIssueRequestDepth(evidence.sourceIssue.requestDepth + 1),
      });
    } catch (error) {
      if (!isActiveProductivityReviewUniqueConflict(error)) throw error;
      const raced = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
      if (!raced) throw error;
      return { kind: "existing" as const, reviewIssueId: raced.id };
    }

    await logActivity(db, {
      companyId: evidence.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_created",
      entityType: "issue",
      entityId: review.id,
      agentId: ownerAgentId,
      details: {
        source: "productivity_review.reconcile",
        sourceIssueId: evidence.sourceIssue.id,
        trigger: evidence.trigger,
        noCommentStreak: evidence.noCommentStreak,
        runCountLastHour: evidence.runCountLastHour,
        commentCountLastHour: evidence.commentCountLastHour,
      },
    });

    if (ownerAgentId && deps?.enqueueWakeup) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: review.id,
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: "productivity_review",
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: review.id,
          taskId: review.id,
          wakeReason: "issue_assigned",
          source: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          sourceIssueId: evidence.sourceIssue.id,
          productivityReviewTrigger: evidence.trigger,
        }, "status_only"),
      });
    }

    return { kind: "created" as const, reviewIssueId: review.id };
  }

  async function createProductivityReviewEscalation(input: {
    sourceIssue: IssueRow;
    priorReviewCount: number;
    thresholds: ProductivityReviewThresholds;
    now: Date;
  }) {
    const existing = await findOpenProductivityReviewEscalation(input.sourceIssue.companyId, input.sourceIssue.id);
    if (existing) return { kind: "existing" as const, escalationIssueId: existing.id };

    const [ownerUserId, priorReviews] = await Promise.all([
      resolveEscalationOwnerUserId(input.sourceIssue.companyId),
      latestResolvedProductivityReviews(
        input.sourceIssue.companyId,
        input.sourceIssue.id,
        input.thresholds.escalationLookbackMs,
        input.now,
      ),
    ]);
    const lookbackDays = Math.round(input.thresholds.escalationLookbackMs / (24 * 60 * 60 * 1000));
    const priorReviewLines = priorReviews.length > 0
      ? priorReviews.map((review) => `- ${review.identifier ?? review.id}: ${review.status}, updated ${review.updatedAt.toISOString()}`).join("\n")
      : "- no prior review rows available in the sampled lookback";

    const escalation = await issuesSvc.create(input.sourceIssue.companyId, {
      title: `[user-cover] productivity-review escalation: ${input.sourceIssue.identifier ?? input.sourceIssue.title} — ${input.priorReviewCount} prior reviews in ${lookbackDays}d`,
      description: [
        `Productivity review hit the repeat-review cap for ${input.sourceIssue.identifier ?? input.sourceIssue.id}.`,
        "",
        `- Source status: ${input.sourceIssue.status}`,
        `- Source assignee agent: ${input.sourceIssue.assigneeAgentId ?? "none"}`,
        `- Prior review count: ${input.priorReviewCount} prior resolved productivity reviews in ${lookbackDays}d`,
        `- Latest source activity: ${input.sourceIssue.lastActivityAt?.toISOString?.() ?? input.sourceIssue.updatedAt.toISOString()}`,
        `- Source started at: ${input.sourceIssue.startedAt?.toISOString?.() ?? "unknown"}`,
        `- Source monitor next check: ${input.sourceIssue.monitorNextCheckAt?.toISOString?.() ?? "none"}`,
        "",
        "## Recent wrapper verdicts",
        "",
        priorReviewLines,
        "",
        "## User direction needed",
        "",
        "Please choose one explicit direction: cancel / hand off / decompose / let it run with the opt-out flag.",
      ].join("\n"),
      status: "todo",
      priority: "high",
      parentId: input.sourceIssue.id,
      projectId: input.sourceIssue.projectId,
      goalId: input.sourceIssue.goalId,
      billingCode: input.sourceIssue.billingCode,
      assigneeAgentId: null,
      assigneeUserId: ownerUserId,
      originKind: RECOVERY_ORIGIN_KINDS.productivityReviewEscalation,
      originId: input.sourceIssue.id,
      originFingerprint: productivityReviewEscalationFingerprint(input.sourceIssue.id),
      requestDepth: clampIssueRequestDepth(input.sourceIssue.requestDepth + 1),
    });

    if (["todo", "in_progress", "in_review", "blocked"].includes(input.sourceIssue.status)) {
      const existingBlockers = await db
        .select({ blockerIssueId: issueRelations.issueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.sourceIssue.companyId),
            eq(issueRelations.relatedIssueId, input.sourceIssue.id),
            eq(issueRelations.type, "blocks"),
          ),
        );
      await issuesSvc.update(input.sourceIssue.id, {
        status: "blocked",
        blockedByIssueIds: [...new Set([...existingBlockers.map((row) => row.blockerIssueId), escalation.id])],
      });
    }

    logger.info(
      {
        companyId: input.sourceIssue.companyId,
        sourceIssueId: input.sourceIssue.id,
        priorReviewCount: input.priorReviewCount,
        escalationIssueId: escalation.id,
      },
      "productivity review escalated chronic source issue",
    );

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  // BLO-6243: record a suppressed terminal-source review as an audit-only decision. No review
  // issue is created and no wake comment is enqueued — this is purely an attributable trace so
  // the suppression is observable rather than an indistinguishable generic skip.
  async function recordTerminalSourceSuppression(
    evidence: ProductivityReviewEvidence,
    sourceStatus: string | null,
  ) {
    await logActivity(db, {
      companyId: evidence.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: evidence.sourceIssue.id,
      agentId: evidence.sourceAgent.id,
      details: {
        source: "productivity_review.reconcile",
        decision: "suppress_terminal_source",
        sourceIssueId: evidence.sourceIssue.id,
        sourceStatus,
        trigger: evidence.trigger,
        noCommentStreak: evidence.noCommentStreak,
      },
    });
  }

  async function reconcileProductivityReviews(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds = buildThresholds(opts?.thresholds);
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          isNull(issues.hiddenAt),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
          sql`${issues.originKind} <> ${PRODUCTIVITY_REVIEW_ORIGIN_KIND}`,
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      scanned: candidates.length,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      escalated: 0,
      optedOut: 0,
      monitorScheduledSuppressed: 0,
      closedSuppressedMonitorReviews: 0,
      skipped: 0,
      suppressedTerminalSource: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

    result.closedSuppressedMonitorReviews = await closeOpenSuppressedMonitorReviews(now, opts?.companyId);

    const prefixCache = new Map<string, string>();
    for (const candidate of candidates) {
      if (!candidate.assigneeAgentId) {
        result.skipped += 1;
        continue;
      }
      if (await isProductivityReviewDescendant(candidate)) {
        result.skipped += 1;
        continue;
      }
      if (isProductivityReviewOptedOut(candidate)) {
        result.optedOut += 1;
        continue;
      }
      const sourceAgent = await getAgent(candidate.assigneeAgentId);
      if (!sourceAgent || sourceAgent.companyId !== candidate.companyId) {
        result.skipped += 1;
        continue;
      }
      const evidence = await collectEvidence(candidate, sourceAgent, thresholds, now);
      if (!evidence) {
        result.skipped += 1;
        continue;
      }
      if (isMonitorScheduledSuppression(evidence)) {
        await recordMonitorScheduledSuppression(evidence);
        result.monitorScheduledSuppressed += 1;
        continue;
      }
      if (await findRecentResolvedProductivityReview(candidate.companyId, candidate.id, thresholds, now)) {
        result.snoozed += 1;
        continue;
      }
      const priorReviewCount = await countResolvedProductivityReviews(
        candidate.companyId,
        candidate.id,
        thresholds.escalationLookbackMs,
        now,
      );
      if (priorReviewCount >= thresholds.escalationThreshold) {
        const outcome = await createProductivityReviewEscalation({
          sourceIssue: candidate,
          priorReviewCount,
          thresholds,
          now,
        });
        if (outcome.kind === "existing") result.existing += 1;
        else result.escalated += 1;
        result.reviewIssueIds.push(outcome.escalationIssueId);
        continue;
      }
      if (await hasRepeatedTerminalReviewsInBackoff(candidate.companyId, candidate.id, now)) {
        result.snoozed += 1;
        continue;
      }
      let prefix = prefixCache.get(candidate.companyId);
      if (!prefix) {
        prefix = await getCompanyIssuePrefix(candidate.companyId);
        prefixCache.set(candidate.companyId, prefix);
      }
      try {
        await deps?.beforeCreateOrUpdateReview?.(evidence);
        const reviewability = await evaluateSourceReviewability(candidate, sourceAgent.id);
        if (!reviewability.reviewable) {
          if (reviewability.terminal) {
            await recordTerminalSourceSuppression(evidence, reviewability.status);
            result.suppressedTerminalSource += 1;
          } else {
            result.skipped += 1;
          }
          continue;
        }
        const outcome = await createOrUpdateReview(evidence, { prefix });
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "updated") result.updated += 1;
        else if (outcome.kind === "skipped") result.skipped += 1;
        else result.existing += 1;
        if (outcome.reviewIssueId) result.reviewIssueIds.push(outcome.reviewIssueId);
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(candidate.id);
        logger.warn(
          {
            err,
            companyId: candidate.companyId,
            issueId: candidate.id,
            requestDepth: candidate.requestDepth,
          },
          "productivity review reconciliation skipped malformed candidate",
        );
      }
    }

    return result;
  }

  async function isProductivityReviewContinuationHoldActive(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = input.now ?? new Date();
    const thresholds = buildThresholds(input.thresholds);
    const [sourceIssue, sourceAgent, openReview] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
        .then((rows) => rows[0] ?? null),
      getAgent(input.agentId),
      findOpenProductivityReview(input.companyId, input.issueId),
    ]);
    if (!sourceIssue || !sourceAgent || !openReview) return { held: false as const };
    if (sourceAgent.companyId !== input.companyId) return { held: false as const };
    const evidence = await collectEvidence(sourceIssue, sourceAgent, thresholds, now);
    if (!evidence || isMonitorScheduledSuppression(evidence)) {
      return { held: false as const };
    }
    if (!isSoftStopTrigger(evidence.trigger) || evidence.routineOnlySamplingWindow) {
      return { held: false as const };
    }
    return {
      held: true as const,
      reviewIssueId: openReview.id,
      reviewIdentifier: openReview.identifier,
      trigger: evidence.trigger,
      reason: evidence.triggerReasons.join("; "),
    };
  }

  async function recordContinuationHold(input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    reviewIssueId: string;
    trigger: ProductivityReviewTrigger;
    reason: string;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.productivity_review_continuation_held",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        source: "productivity_review.continuation_hold",
        reviewIssueId: input.reviewIssueId,
        trigger: input.trigger,
        reason: input.reason,
      },
    });
  }

  return {
    reconcileProductivityReviews,
    countResolvedProductivityReviews,
    isProductivityReviewContinuationHoldActive,
    recordContinuationHold,
  };
}
