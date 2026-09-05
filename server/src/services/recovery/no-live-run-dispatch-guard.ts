import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";
import type { IssueCommentPresentation } from "@paperclipai/shared";
import type { LogActivityInput } from "../activity-log.js";
import { systemNoticePresentation } from "./notice-format.js";
import type { StrandedRecoveryNoticeSeed } from "./stranded-notice.js";

export const NO_LIVE_RUN_NOTICE_TITLE = "No live execution path";
export const NEEDS_DISPATCH_NOTICE_TITLE = "Needs dispatch";
export const NEEDS_DISPATCH_SOURCE = "recovery.needs_dispatch";

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];
const UNBLOCK_STATUSES = ["todo", "in_progress", "in_review", "backlog"];

function positiveEnvInt(raw: string | undefined, fallback: number, floor: number) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(floor, parsed) : fallback;
}

// An explicit agent or user unblock stays authoritative for this long. Recovery
// can look at the issue again after the window, but it must not overwrite the
// decision inside it.
export const RECOVERY_UNBLOCK_COOLDOWN_MS = positiveEnvInt(
  process.env.RECOVERY_UNBLOCK_COOLDOWN_MS,
  60 * 60 * 1000,
  60_000,
);

// "Needs dispatch" is bounded. An issue that cannot be dispatched after this
// many attempts in the window below is genuinely stuck, and it escalates.
export const RECOVERY_NEEDS_DISPATCH_MAX_ATTEMPTS = positiveEnvInt(
  process.env.RECOVERY_NEEDS_DISPATCH_MAX_ATTEMPTS,
  3,
  1,
);
export const RECOVERY_NEEDS_DISPATCH_WINDOW_MS = positiveEnvInt(
  process.env.RECOVERY_NEEDS_DISPATCH_WINDOW_MS,
  24 * 60 * 60 * 1000,
  60_000,
);

export type NoLiveRunGuardDecision =
  | { decision: "block"; reason: string; attempts?: number }
  | { decision: "skip"; reason: string; [key: string]: unknown }
  | { decision: "needs_dispatch"; attempts: number; maxAttempts: number };

type GuardIssue = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "originKind"
>;

// Separates "we could not find a live run" from first-class blockers such as
// workspace_validation_failed or configuration_incomplete, which keep blocking.
export function isNoLiveRunEscalation(input: {
  notice?: StrandedRecoveryNoticeSeed | null;
  comment?: string;
}) {
  const title = typeof input.notice?.title === "string" ? input.notice.title.trim() : "";
  if (title.length > 0) return title === NO_LIVE_RUN_NOTICE_TITLE;
  return /no live execution path/i.test(`${input.notice?.body ?? ""} ${input.comment ?? ""}`);
}

async function findLiveRun(db: Db, issue: GuardIssue) {
  return db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
      inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function findRecentExplicitUnblock(db: Db, issue: GuardIssue, since: Date) {
  return db
    .select({
      id: activityLog.id,
      createdAt: activityLog.createdAt,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityId, issue.id),
      gt(activityLog.createdAt, since),
      inArray(activityLog.actorType, ["agent", "user"]),
      or(
        eq(activityLog.action, "issue.recovery_action_resolved"),
        and(
          eq(activityLog.action, "issue.updated"),
          inArray(sql`${activityLog.details} ->> 'status'`, UNBLOCK_STATUSES),
        ),
      ),
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function countNeedsDispatchAttempts(db: Db, issue: GuardIssue, since: Date) {
  return db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, issue.companyId),
      eq(activityLog.entityId, issue.id),
      gt(activityLog.createdAt, since),
      sql`${activityLog.details} ->> 'source' = ${NEEDS_DISPATCH_SOURCE}`,
    ))
    .then((rows) => rows.length);
}

export async function evaluateNoLiveRunDispatchGuard(db: Db, input: {
  issue: GuardIssue;
  notice?: StrandedRecoveryNoticeSeed | null;
  comment?: string;
  now?: Date;
}): Promise<NoLiveRunGuardDecision> {
  const { issue } = input;
  const now = input.now ?? new Date();

  // Routine-execution issues have their own stranded-recovery disposition, so
  // this guard leaves them alone.
  if (issue.originKind === "routine_execution") {
    return { decision: "block", reason: "routine_execution_issue" };
  }

  // The snapshot the sweep scanned with can be many seconds stale. Re-read the
  // row so the decision reflects the state at write time.
  const current = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!current) return { decision: "skip", reason: "issue_missing" };
  if (TERMINAL_ISSUE_STATUSES.includes(current.status)) {
    return { decision: "skip", reason: "issue_terminal", status: current.status };
  }

  const liveRun = await findLiveRun(db, issue);
  if (liveRun) return { decision: "skip", reason: "live_run_present", runId: liveRun.id };

  const unblock = await findRecentExplicitUnblock(
    db,
    issue,
    new Date(now.getTime() - RECOVERY_UNBLOCK_COOLDOWN_MS),
  );
  if (unblock) {
    return {
      decision: "skip",
      reason: "explicit_unblock_cooldown",
      unblockedAt: unblock.createdAt,
      unblockedByActorType: unblock.actorType,
      unblockedByActorId: unblock.actorId,
      cooldownMs: RECOVERY_UNBLOCK_COOLDOWN_MS,
    };
  }

  if (!isNoLiveRunEscalation(input)) {
    return { decision: "block", reason: "first_class_blocker" };
  }

  const attempts = await countNeedsDispatchAttempts(
    db,
    issue,
    new Date(now.getTime() - RECOVERY_NEEDS_DISPATCH_WINDOW_MS),
  );
  if (attempts >= RECOVERY_NEEDS_DISPATCH_MAX_ATTEMPTS) {
    return { decision: "block", reason: "needs_dispatch_exhausted", attempts };
  }
  return { decision: "needs_dispatch", attempts, maxAttempts: RECOVERY_NEEDS_DISPATCH_MAX_ATTEMPTS };
}

export function buildNeedsDispatchNotice(input: { attempts: number; maxAttempts: number }) {
  const attemptCopy = input.attempts > 0 ? ` (attempt ${input.attempts + 1} of ${input.maxAttempts})` : "";
  return {
    body:
      "Paperclip found no live execution path for this assigned issue. " +
      `It moved the issue back to \`todo\` for dispatch${attemptCopy}. ` +
      "This is a dispatch gap, not a blocker. No operator action is necessary. " +
      "If dispatch continues to fail, Paperclip escalates the issue to `blocked`.",
    presentation: systemNoticePresentation({ tone: "info", title: NEEDS_DISPATCH_NOTICE_TITLE }),
  };
}

// Returns the issue to the dispatch queue and clears the stale execution lock,
// so the assigned-todo liveness sweep can hand it to the assignee again.
export async function markIssueNeedsDispatch(
  db: Db,
  deps: {
    issuesSvc: { update: (id: string, patch: { status: "todo" }) => Promise<unknown> };
    addComment: (
      issueId: string,
      body: string,
      presentation: IssueCommentPresentation,
    ) => Promise<unknown>;
    logActivity: (db: Db, entry: LogActivityInput) => Promise<unknown>;
  },
  input: {
    issue: GuardIssue;
    previousStatus: string;
    latestRun: { id: string; status: string } | null;
    attempts: number;
    maxAttempts: number;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const updated = await deps.issuesSvc.update(input.issue.id, { status: "todo" });
  if (!updated) return null;

  await db
    .update(issues)
    .set({
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: now,
    })
    .where(eq(issues.id, input.issue.id));

  const notice = buildNeedsDispatchNotice({ attempts: input.attempts, maxAttempts: input.maxAttempts });
  await deps.addComment(input.issue.id, notice.body, notice.presentation);
  await deps.logActivity(db, {
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "system",
    agentId: null,
    runId: null,
    action: "issue.updated",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      identifier: input.issue.identifier,
      status: "todo",
      previousStatus: input.previousStatus,
      source: NEEDS_DISPATCH_SOURCE,
      recoveryCause: "no_live_execution_path",
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
    },
  });
  return updated;
}
