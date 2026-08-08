import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { budgetService } from "./budgets.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import { apiLatencyTracker } from "./recovery/load-guard.js";
import { resolveAgentJwtTtlSeconds } from "../agent-auth-jwt.js";

export const PRODUCTIVITY_REVIEW_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.issueProductivityReview;
export const DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS = 6;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS = 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW = 1;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS = 3;
// RBR-1013 (RBR-977 scope item 4) — a "no comment" observation sampled while
// the API itself was slow is unattributable to the agent: RBR-977 measured
// `GET /api/agents/me` taking 53.2s and a single POST taking 101.4s under
// load average 52.40 on 12 cores. Default matches the recovery load gate's
// API latency threshold for the same reason (see recovery/load-guard.ts).
export const DEFAULT_PRODUCTIVITY_REVIEW_API_P50_THRESHOLD_MS = 5_000;

const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const MAX_CANDIDATE_ISSUES = 250;
const MAX_RUNS_FOR_STREAK = 100;
const MAX_PARENT_WALK_DEPTH = 25;
export const PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX = "Productivity review evidence refreshed.";

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
// Evidence only reads these run fields; selecting the full row detoasts
// result_json/context_snapshot for up to MAX_RUNS_FOR_STREAK runs per issue.
type ProductivityRunSample = Pick<
  HeartbeatRunRow,
  "id" | "agentId" | "status" | "livenessState" | "createdAt" | "startedAt" | "finishedAt" | "nextAction" | "usageJson"
>;
type ProductivityReviewTrigger = "no_comment_streak" | "long_active_duration" | "high_churn";

type ProductivityReviewThresholds = {
  noCommentStreakRuns: number;
  longActiveMs: number;
  highChurnHourly: number;
  highChurnSixHours: number;
  resolvedSnoozeMs: number;
  refreshIntervalMs: number;
  maxRefreshComments: number;
  creationWindowMs: number;
  maxCreationsPerWindow: number;
  maxConsecutiveNoActionReviews: number;
  /** RBR-1013: `no_comment_streak` is suppressed rather than reviewed when
   * the sample window's API p50 exceeds this. */
  apiP50ThresholdMs: number;
  /** RBR-1013: `no_comment_streak` is suppressed when any streak run's
   * (finishedAt - startedAt) exceeds this — the run outlived the agent JWT
   * it was minted with and could not have posted a closing comment even if
   * the API had been instantaneous. */
  jwtTtlMs: number;
};

/** RBR-1013 (RBR-977 scope item 4) — why a `no_comment_streak` observation
 * was suppressed instead of turned into a review issue. Both causes are
 * unattributable to the agent: the API was measurably slow, or the run's
 * own credential expired before it could act. A third cause named in the
 * ticket — "killed-mid-flight" — is already covered by the existing
 * liveness-state exclusion of non-terminal/killed runs from the streak
 * count, so it does not need a separate reason here. */
export type NoCommentStreakSuppressionReason = "degraded_window_api_latency" | "run_credential_expired";

export type NoCommentStreakSuppression = {
  reasons: NoCommentStreakSuppressionReason[];
  apiP50Ms: number | null;
  credentialExpiredRunIds: string[];
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
  latestRuns: ProductivityRunSample[];
  latestComments: Array<typeof issueComments.$inferSelect>;
  costCents: number;
  usageSamples: Array<{ runId: string; usageJson: Record<string, unknown> | null }>;
  nextAction: string | null;
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

function productivityReviewFingerprint(sourceIssueId: string) {
  return `productivity-review:${sourceIssueId}`;
}

function issueRunScopeSql(issueId: string) {
  return sql`(
    ${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}
    or ${heartbeatRuns.contextSnapshot}->>'taskKey' = ${issueId}
  )`;
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

function coerceDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
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
    refreshIntervalMs: readPositiveInteger(
      overrides?.refreshIntervalMs ?? DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
    ),
    maxRefreshComments: readPositiveInteger(
      overrides?.maxRefreshComments ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
    ),
    creationWindowMs: readPositiveInteger(
      overrides?.creationWindowMs ?? DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
    ),
    maxCreationsPerWindow: readPositiveInteger(
      overrides?.maxCreationsPerWindow ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
    ),
    maxConsecutiveNoActionReviews: readPositiveInteger(
      overrides?.maxConsecutiveNoActionReviews ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
    ),
    apiP50ThresholdMs: readPositiveInteger(
      overrides?.apiP50ThresholdMs ?? DEFAULT_PRODUCTIVITY_REVIEW_API_P50_THRESHOLD_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_API_P50_THRESHOLD_MS,
    ),
    jwtTtlMs: readPositiveInteger(
      overrides?.jwtTtlMs ?? resolveAgentJwtTtlSeconds() * 1000,
      resolveAgentJwtTtlSeconds() * 1000,
    ),
  };
}

/**
 * RBR-1013 (RBR-977 scope item 4) — decide whether a `no_comment_streak`
 * observation is attributable to the agent at all. A completed run with no
 * comment has at least three non-agent causes: the closing POST was too
 * slow to return, the run's own credential expired before it could act, or
 * the run was killed mid-flight (already excluded upstream by the liveness
 * filter feeding `latestRuns`). This function covers the first two.
 *
 * `apiP50Ms` is read once at evidence-collection time (the sample window is
 * "now", matching what the agent would have experienced while trying to
 * comment) rather than reconstructed after the fact — there is no per-run
 * historical latency record, only the live process-local tracker.
 */
export function evaluateNoCommentStreakSuppression(input: {
  streakRuns: ProductivityRunSample[];
  apiP50Ms: number | null;
  thresholds: ProductivityReviewThresholds;
}): NoCommentStreakSuppression {
  const reasons: NoCommentStreakSuppressionReason[] = [];
  if (input.apiP50Ms !== null && input.apiP50Ms > input.thresholds.apiP50ThresholdMs) {
    reasons.push("degraded_window_api_latency");
  }
  const credentialExpiredRunIds = input.streakRuns
    .filter((run) => {
      if (!run.startedAt || !run.finishedAt) return false;
      const durationMs = run.finishedAt.getTime() - run.startedAt.getTime();
      return durationMs > input.thresholds.jwtTtlMs;
    })
    .map((run) => run.id);
  if (credentialExpiredRunIds.length > 0) {
    reasons.push("run_credential_expired");
  }
  return { reasons, apiP50Ms: input.apiP50Ms, credentialExpiredRunIds };
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

export function productivityReviewService(
  db: Db,
  deps?: {
    enqueueWakeup?: EnqueueWakeup;
    /** RBR-1013: injectable API p50 (ms) reader. Defaults to the
     * process-wide `apiLatencyTracker`, scoped to the caller-supplied
     * window (see `collectEvidence` — the window is bounded to the
     * no-comment streak's own time span, not the tracker's full six-hour
     * retention), anchored at the caller-supplied `at` (the streak's own
     * end time, not "now" — see Greptile P1 on PR #11028: reconciliation
     * can run well after the streak's newest run finished, and unrelated
     * same-company latency in that gap must not retroactively explain a
     * streak it never overlapped), and scoped to the caller-supplied
     * `companyId` — a shared multi-tenant instance must never let one
     * company's slow API traffic suppress another company's genuine
     * no-comment streak. */
    readApiP50Ms?: (windowMs?: number, companyId?: string, at?: number) => number | null;
  },
) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);
  const readApiP50Ms =
    deps?.readApiP50Ms ??
    ((windowMs?: number, companyId?: string, at?: number) => apiLatencyTracker.getP50(windowMs, at, companyId));

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
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findRecentTerminalProductivityReview(
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

  async function countRecentProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.creationWindowMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          sql`${issues.status} <> 'cancelled'`,
          sql`${issues.createdAt} >= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countConsecutiveNoActionProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
  ) {
    const completedReviews = await db
      .select({
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          visibleIssueCondition(),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(thresholds.maxConsecutiveNoActionReviews);

    const earliestReviewCreatedAt = completedReviews.at(-1)?.createdAt;
    if (!earliestReviewCreatedAt) return 0;
    const sourceActions = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, sourceIssueId),
          gte(activityLog.createdAt, earliestReviewCreatedAt),
        ),
      );

    let streak = 0;
    for (const [index, review] of completedReviews.entries()) {
      const nextNewerReviewCreatedAt = completedReviews[index - 1]?.createdAt ?? null;
      const sourceAction = sourceActions.some((activity) => {
        if (activity.createdAt < review.createdAt) return false;
        return !nextNewerReviewCreatedAt || activity.createdAt < nextNewerReviewCreatedAt;
      });
      if (sourceAction) break;
      streak += 1;
    }
    return streak;
  }

  async function getRefreshCommentState(companyId: string, reviewIssueId: string) {
    return db
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
        ),
      )
      .then((rows) => {
        const row = rows[0];
        return {
          count: Number(row?.count ?? 0),
          latestCreatedAt: coerceDate(row?.latestCreatedAt),
        };
      });
  }

  async function addRefreshComment(
    reviewIssueId: string,
    body: string,
    generatedAt: Date,
  ) {
    const comment = await issuesSvc.addComment(reviewIssueId, body, {});
    await db
      .update(issueComments)
      .set({ createdAt: generatedAt, updatedAt: generatedAt })
      .where(eq(issueComments.id, comment.id));
    await db
      .update(issues)
      .set({ updatedAt: generatedAt })
      .where(eq(issues.id, reviewIssueId));
    return comment;
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
  ): Promise<ProductivityReviewEvidence | null> {
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const latestRuns = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        nextAction: heartbeatRuns.nextAction,
        usageJson: heartbeatRuns.usageJson,
      })
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

    // RBR-1013 (RBR-977 scope item 4) — before treating a no-comment streak
    // as attributable to the agent, check whether it is explainable by API
    // degradation or credential expiry. Scoped to the runs that make up the
    // streak itself, not the whole `latestRuns` sample: a run outside the
    // streak having run long is irrelevant to *this* observation.
    const streakRuns = terminalRuns.slice(0, noCommentStreak);
    // Bound the API-latency sample to the streak's own time span: from the
    // oldest streak run's start through the newest streak run's finish
    // (not "now") rather than the tracker's full six-hour retention —
    // otherwise latency from an unrelated request (different issue,
    // different company, a period before this streak even started, or —
    // Greptile P1 on PR #11028 — a period *after* the streak's last run
    // finished but before this reconciliation pass happened to run) could
    // suppress a genuine no-comment streak it never overlapped.
    const oldestStreakRun = streakRuns[streakRuns.length - 1];
    const newestStreakRun = streakRuns[0];
    const streakWindowEndAt = newestStreakRun
      ? (newestStreakRun.finishedAt ?? newestStreakRun.createdAt).getTime()
      : now.getTime();
    const streakWindowMs = oldestStreakRun
      ? Math.max(1, streakWindowEndAt - (oldestStreakRun.startedAt ?? oldestStreakRun.createdAt).getTime())
      : undefined;
    const apiP50Ms = readApiP50Ms(streakWindowMs, sourceIssue.companyId, streakWindowEndAt);
    const suppression = evaluateNoCommentStreakSuppression({ streakRuns, apiP50Ms, thresholds });
    const noCommentSuppressed = noCommentStreak >= thresholds.noCommentStreakRuns && suppression.reasons.length > 0;
    const noComment = noCommentStreak >= thresholds.noCommentStreakRuns && !noCommentSuppressed;
    const longActive = elapsedMs !== null && elapsedMs >= thresholds.longActiveMs;
    const highChurn =
      runCountLastHour >= thresholds.highChurnHourly ||
      assigneeRunCommentCountLastHour >= thresholds.highChurnHourly ||
      runCountLastSixHours >= thresholds.highChurnSixHours ||
      assigneeRunCommentCountLastSixHours >= thresholds.highChurnSixHours;
    const trigger = choosePrimaryTrigger({ noComment, longActive, highChurn });
    if (!trigger) {
      if (noCommentSuppressed) {
        logger.info(
          {
            issueId: sourceIssue.id,
            agentId: sourceAgent.id,
            noCommentStreak,
            suppressionReasons: suppression.reasons,
            apiP50Ms: suppression.apiP50Ms,
            credentialExpiredRunIds: suppression.credentialExpiredRunIds,
          },
          "productivity review no_comment_streak suppressed: unattributable to agent",
        );
      }
      return null;
    }

    const triggerReasons: string[] = [];
    if (noComment) triggerReasons.push(`${noCommentStreak} consecutive completed issue-linked runs had no run-created issue comment`);
    if (longActive) triggerReasons.push(`current active episode has lasted ${msToHuman(elapsedMs)}`);
    if (highChurn) {
      triggerReasons.push(
        `${runCountLastHour} runs/${assigneeRunCommentCountLastHour} assignee-run comments in 1h; ${runCountLastSixHours} runs/${assigneeRunCommentCountLastSixHours} assignee-run comments in 6h`,
      );
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
      "- Close as productive if this pattern is expected.",
      "- Continue with a snooze window if the current work should keep running without repeat review spam.",
      "- Request decomposition, reroute, block with an unblock owner, or stop/cancel the source work if the work is inefficient.",
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
    opts: { prefix: string; thresholds: ProductivityReviewThresholds },
  ) {
    const existing = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
    if (existing) {
      const refreshState = await getRefreshCommentState(evidence.sourceIssue.companyId, existing.id);
      const lastRefreshOrCreationAt = refreshState.latestCreatedAt ?? existing.createdAt;
      if (
        refreshState.count >= opts.thresholds.maxRefreshComments ||
        evidence.generatedAt.getTime() - lastRefreshOrCreationAt.getTime() < opts.thresholds.refreshIntervalMs
      ) {
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }
      await addRefreshComment(existing.id, buildRefreshComment(evidence, opts.prefix), evidence.generatedAt);
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

    const recentCreationCount = await countRecentProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
      evidence.generatedAt,
    );
    if (recentCreationCount >= opts.thresholds.maxCreationsPerWindow) {
      return { kind: "creation_capped" as const, reviewIssueId: null };
    }

    const consecutiveNoActionReviews = await countConsecutiveNoActionProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
    );
    if (consecutiveNoActionReviews >= opts.thresholds.maxConsecutiveNoActionReviews) {
      return { kind: "no_action_suppressed" as const, reviewIssueId: null };
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
      const maybe = error as { code?: string; constraint?: string; message?: string };
      const uniqueConflict = maybe.code === "23505" &&
        (
          maybe.constraint === "issues_active_productivity_review_uq" ||
          typeof maybe.message === "string" && maybe.message.includes("issues_active_productivity_review_uq")
        );
      if (!uniqueConflict) throw error;
      const raced = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
      if (!raced) throw error;
      return { kind: "existing" as const, reviewIssueId: raced.id };
    }
    await db
      .update(issues)
      .set({ createdAt: evidence.generatedAt, updatedAt: evidence.generatedAt })
      .where(eq(issues.id, review.id));

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

  async function reconcileProductivityReviews(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<ProductivityReviewThresholds>;
    issueCreatedAtGte?: Date | null;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds = buildThresholds(opts?.thresholds);
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          visibleIssueCondition(),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
          sql`${issues.originKind} <> ${PRODUCTIVITY_REVIEW_ORIGIN_KIND}`,
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
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
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

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
      if (await findRecentTerminalProductivityReview(candidate.companyId, candidate.id, thresholds, now)) {
        result.snoozed += 1;
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
      let prefix = prefixCache.get(candidate.companyId);
      if (!prefix) {
        prefix = await getCompanyIssuePrefix(candidate.companyId);
        prefixCache.set(candidate.companyId, prefix);
      }
      try {
        const outcome = await createOrUpdateReview(evidence, { prefix, thresholds });
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "updated") result.updated += 1;
        else if (outcome.kind === "creation_capped") result.creationCapped += 1;
        else if (outcome.kind === "no_action_suppressed") result.noActionSuppressed += 1;
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
    if (!evidence || !isSoftStopTrigger(evidence.trigger)) return { held: false as const };
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
    isProductivityReviewContinuationHoldActive,
    recordContinuationHold,
  };
}
