import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issues } from "@paperclipai/db";

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

export type StrandedEscalationGuardDecision =
  | { decision: "block"; reason: string }
  | { decision: "skip"; reason: string; [key: string]: unknown };

type GuardIssue = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "originKind"
>;

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

// Decides whether a stranded-recovery escalation may still write `blocked`.
// The sweep selects its candidates, and then does more asynchronous work before
// it reaches the write. The issue can change during that gap. This guard reads
// the current state at write time, so a stale snapshot cannot overwrite a newer
// decision. It never downgrades a real escalation; it only suppresses one that
// the current state has already made wrong.
export async function evaluateStrandedEscalationGuard(db: Db, input: {
  issue: GuardIssue;
  now?: Date;
}): Promise<StrandedEscalationGuardDecision> {
  const { issue } = input;
  const now = input.now ?? new Date();

  // Routine-execution issues have their own stranded-recovery disposition, so
  // this guard leaves them alone.
  if (issue.originKind === "routine_execution") {
    return { decision: "block", reason: "routine_execution_issue" };
  }

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

  return { decision: "block", reason: "no_conflicting_state" };
}
