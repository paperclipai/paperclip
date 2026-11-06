import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { ISSUE_TREE_RESUME_EXECUTABLE_STATUSES, issueTreeControlService } from "./issue-tree-control.js";

type ResumeActor = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
};

type Wakeup = (agentId: string, opts: {
  source: "assignment";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  requestedByActorType: ResumeActor["actorType"];
  requestedByActorId: string;
  idempotencyKey: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

/** A claim older than this with no saved wake belongs to an interrupted dispatcher. */
export const PAUSE_RESUME_CLAIM_STALE_MS = 60_000;

export function pauseResumeWakeKey(runId: string) {
  return `tree-hold-resume:${runId}`;
}

const SYSTEM_ACTOR: ResumeActor = { actorType: "system", actorId: "system" };

function activity(db: Db, companyId: string, actor: ResumeActor, action: string, issueId: string,
  details: Record<string, unknown>) {
  return logActivity(db, {
    companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId ?? null,
    runId: actor.runId ?? null, agentApiKeyId: actor.agentApiKeyId ?? null, action,
    entityType: "issue", entityId: issueId, details,
  });
}

/** Compare-and-set the run's resume record. Only the writer that wins dispatches. */
async function setResumeState(db: Db, input: {
  companyId: string; runId: string; next: Record<string, unknown>; expectedClaimedAt?: string | null;
}) {
  const guard = input.expectedClaimedAt === undefined
    ? sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'treeHoldResume')`
    : sql`${heartbeatRuns.resultJson}->'treeHoldResume'->>'claimedAt' is not distinct from ${input.expectedClaimedAt}`;
  return db.transaction(async tx => {
    const [row] = await tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ treeHoldResume: input.next })}::jsonb`,
    }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.status, "cancelled"), guard)).returning({ id: heartbeatRuns.id });
    // A pending claim arms the recovery sweep in the same commit, so a crash
    // before the wake is saved is retried.
    if (row && input.next.state === "pending") await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    return Boolean(row);
  });
}

async function dispatch(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; holdId: string;
  claimedAt: string; rootIssueId: string | null; actor: ResumeActor; wakeup: Wakeup;
}) {
  await input.wakeup(input.agentId, {
    source: "assignment",
    triggerDetail: "system",
    reason: "issue_tree_resumed",
    payload: { issueId: input.issueId, rootIssueId: input.rootIssueId, holdId: input.holdId, interruptedRunId: input.runId },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    // The saved wake request is the durable receipt the recovery sweep checks.
    idempotencyKey: pauseResumeWakeKey(input.runId),
    contextSnapshot: {
      issueId: input.issueId,
      taskId: input.issueId,
      wakeReason: "issue_tree_resumed",
      source: "issue.tree_resume",
      rootIssueId: input.rootIssueId,
      holdId: input.holdId,
      interruptedRunId: input.runId,
    },
  });
  await setResumeState(db, { companyId: input.companyId, runId: input.runId, expectedClaimedAt: input.claimedAt,
    next: { holdId: input.holdId, state: "delivered", claimedAt: input.claimedAt, deliveredAt: new Date().toISOString() } });
}

/**
 * Re-dispatch, once, the work a subtree pause interrupted on each task that is
 * no longer paused. Both a hold release and the executor that settles a
 * cancelled preparation call this, so neither ordering loses the work. A task
 * that still needs execution reconciliation keeps its blocker and is skipped;
 * its obligation stays unclaimed for a later settlement or release. A claim
 * whose wake was never saved (for example after a restart) stays pending and
 * is finished by `deliverPendingPauseResumes`.
 */
export async function resumePauseInterruptedWork(
  db: Db,
  input: { companyId: string; issueIds: string[]; actor: ResumeActor; wakeup: Wakeup; rootIssueId?: string | null },
) {
  const treeControl = issueTreeControlService(db);
  const failures: Array<{ issueId: string; message: string }> = [];
  for (const issueId of [...new Set(input.issueIds)]) {
    try {
      const target = await treeControl.findOwedPauseResume(input.companyId, issueId);
      if (!target) continue;
      const blocker = await getExecutionBlocker(db, input.companyId, issueId);
      if (blocker) {
        await activity(db, input.companyId, input.actor, "issue.tree_resume_wake_skipped", issueId, {
          holdId: target.holdId, interruptedRunId: target.interruptedRunId, cause: blocker.cause,
        });
        continue;
      }
      const claimedAt = new Date().toISOString();
      if (!await setResumeState(db, { companyId: input.companyId, runId: target.interruptedRunId,
        next: { holdId: target.holdId, state: "pending", claimedAt } })) continue;
      await dispatch(db, { companyId: input.companyId, issueId, agentId: target.agentId, runId: target.interruptedRunId,
        holdId: target.holdId, claimedAt, rootIssueId: input.rootIssueId ?? null, actor: input.actor, wakeup: input.wakeup });
    } catch (error) {
      // A pending claim stays recoverable; the sweep retries it after it goes stale.
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ issueId, message });
      await Promise.resolve(activity(db, input.companyId, input.actor, "issue.tree_resume_wake_failed", issueId,
        { error: message })).catch(() => null);
    }
  }
  return failures;
}

function pendingResumePredicate(staleBefore: Date) {
  return and(eq(heartbeatRuns.status, "cancelled"),
    sql`${heartbeatRuns.resultJson}->'treeHoldResume'->>'state' = 'pending'`,
    sql`(${heartbeatRuns.resultJson}->'treeHoldResume'->>'claimedAt')::timestamptz <= ${staleBefore.toISOString()}::timestamptz`);
}

/** True while a claimed resume has no durable receipt yet. */
export async function hasPendingPauseResume(db: Db) {
  const [row] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(sql`${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.resultJson}->'treeHoldResume'->>'state' = 'pending'`)
    .limit(1);
  return Boolean(row);
}

/**
 * Finish resume claims whose dispatcher stopped between claiming and saving the
 * wake (for example a restart). A saved wake with the stable key is the receipt.
 * Otherwise the task's current state is checked again before one dispatch.
 */
export async function deliverPendingPauseResumes(db: Db, wakeup: Wakeup, now = new Date()) {
  const rows = await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    createdAt: heartbeatRuns.createdAt, resultJson: heartbeatRuns.resultJson,
    issueId: sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
  }).from(heartbeatRuns).where(pendingResumePredicate(new Date(now.getTime() - PAUSE_RESUME_CLAIM_STALE_MS))).limit(25);
  for (const run of rows) {
    const claim = run.resultJson?.treeHoldResume as { holdId?: unknown; claimedAt?: unknown } | undefined;
    if (typeof claim?.claimedAt !== "string" || typeof claim.holdId !== "string" || !run.issueId) continue;
    const finish = (state: "delivered" | "abandoned", reason?: string) => setResumeState(db, {
      companyId: run.companyId, runId: run.id, expectedClaimedAt: claim.claimedAt as string,
      next: { holdId: claim.holdId, state, claimedAt: claim.claimedAt, settledAt: now.toISOString(), ...(reason ? { reason } : {}) },
    });
    try {
      const [receipt] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.idempotencyKey, pauseResumeWakeKey(run.id)))).limit(1);
      if (receipt) { await finish("delivered"); continue; }
      const [issue] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId }).from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.issueId)));
      const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId),
        sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${run.issueId}`,
        // JavaScript dates drop microseconds, so exclude the run itself by id.
        sql`${heartbeatRuns.id} <> ${run.id}`,
        sql`${heartbeatRuns.createdAt} >= ${run.createdAt.toISOString()}::timestamptz`)).limit(1);
      if (!issue || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId || newer
        || !ISSUE_TREE_RESUME_EXECUTABLE_STATUSES.includes(issue.status)) {
        await finish("abandoned", "task_changed");
        continue;
      }
      // A paused or blocked task keeps its claim; release or settlement revisits it.
      if (await issueTreeControlService(db).getActivePauseHoldGate(run.companyId, run.issueId)
        || await getExecutionBlocker(db, run.companyId, run.issueId)) continue;
      const claimedAt = now.toISOString();
      if (!await setResumeState(db, { companyId: run.companyId, runId: run.id, expectedClaimedAt: claim.claimedAt,
        next: { holdId: claim.holdId, state: "pending", claimedAt } })) continue;
      await dispatch(db, { companyId: run.companyId, issueId: run.issueId, agentId: run.agentId, runId: run.id,
        holdId: claim.holdId, claimedAt, rootIssueId: null, actor: SYSTEM_ACTOR, wakeup });
    } catch (error) {
      await Promise.resolve(activity(db, run.companyId, SYSTEM_ACTOR, "issue.tree_resume_wake_failed", run.issueId,
        { error: error instanceof Error ? error.message : String(error), interruptedRunId: run.id })).catch(() => null);
    }
  }
}
