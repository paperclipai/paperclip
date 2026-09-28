import { and, desc, eq, gt, inArray, not, or, sql } from "drizzle-orm";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { z } from "zod";
import { heartbeatRuns, issueComments, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { EXECUTION_RECONCILIATION_CAUSES, type ExecutionBlocker } from "@paperclipai/shared";

/** Resolved recovery bookkeeping can still carry an effective no-replay hold. */
export function executionBlockerPredicate() {
  return and(
    not(conversationRecoveryActionPredicate()!),
    inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]),
    // A settled no-replay hold that was released once no longer parks
    // the issue. An operator re-open (`active`/`escalated`) always holds again,
    // so the release marker only ever lifts the settled record it was stamped on.
    sql`not (${issueRecoveryActions.status} in ('resolved', 'cancelled')
      and ${issueRecoveryActions.evidence}->>'settledNoReplayHoldReleasedAt' is not null)`,
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`),
  );
}

/** Evidence stamped when a settled automatic no-replay hold is released. */
const SETTLED_NO_REPLAY_HOLD_RELEASED_AT = "settledNoReplayHoldReleasedAt";

/** A settled hold that only refuses automatic replay, with its bookkeeping intact. */
export function isSettledNoReplayHold(action: typeof issueRecoveryActions.$inferSelect): boolean {
  if (action.status !== "resolved" && action.status !== "cancelled") return false;
  const evidence = (action.evidence ?? {}) as Record<string, unknown>;
  // An unsafe workspace archive stays a hard hold: no wake may start on it.
  if (evidence.workspaceRestoreFailure === "restore_unsafe_archive") return false;
  const automaticRecovery = evidence.automaticRecovery as Record<string, unknown> | undefined;
  return automaticRecovery?.replay === "blocked";
}

export async function isSettledNoReplayHoldOnly(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  if (!blocker?.recoveryActionId) return false;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
  ));
  return actions.length > 0 && actions.every(isSettledNoReplayHold);
}

/**
 * Release a settled automatic no-replay hold exactly once so a fresh wake can
 * create a run. Without this, every later wake on such an issue is
 * parked as `deferred_issue_execution` with no run and the board has no action
 * to resolve, so the issue never runs again. Recorded outcomes, the action
 * status, and its `replay: "blocked"` evidence are preserved; only the
 * release marker is added. Returns null when the issue holds on anything else
 * (an open action, a conversation owner, or an unsafe workspace archive).
 */
export async function releaseSettledNoReplayHold(tx: Db, input: {
  companyId: string; issueId: string; agentId: string;
  reason?: string | null; actorType?: string | null; actorId?: string | null;
}): Promise<string[] | null> {
  const blocker = await getExecutionBlocker(tx, input.companyId, input.issueId);
  if (!blocker?.recoveryActionId) return null;
  const actions = await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId),
    executionBlockerPredicate(),
  )).for("update");
  if (!actions.length) return null;
  // Any open (or otherwise non-settled) hold keeps parking this issue.
  if (!actions.every(isSettledNoReplayHold)) return null;
  const releasedAt = new Date();
  for (const action of actions) {
    const evidence = (action.evidence ?? {}) as Record<string, unknown>;
    await tx.update(issueRecoveryActions).set({
      evidence: {
        ...evidence,
        [SETTLED_NO_REPLAY_HOLD_RELEASED_AT]: releasedAt.toISOString(),
        settledNoReplayHoldRelease: {
          cause: action.cause,
          sourceRunId: action.evidence?.runId ?? action.evidence?.sourceRunId ?? null,
          agentId: input.agentId,
          reason: input.reason ?? null,
          actorType: input.actorType ?? null,
          actorId: input.actorId ?? null,
          releasedAt: releasedAt.toISOString(),
        },
      },
      updatedAt: releasedAt,
    }).where(and(
      eq(issueRecoveryActions.id, action.id),
      eq(issueRecoveryActions.companyId, input.companyId),
    ));
  }
  return actions.map(action => action.id);
}

export async function getExecutionBlocker(db: Db, companyId: string, issueId: string, options?: { conversationResetCommentId?: string | null }): Promise<ExecutionBlocker | null> {
  const [conversation] = await db.select({ agentId: issues.conversationAgentId,
    boundaryId: issues.conversationBoundaryCommentId }).from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.id, issueId),
  )).limit(1);
  // Resetting model context cannot make an unsafe workspace safe. This hold
  // survives conversation boundaries until the existing repair/reconciliation path clears it.
  const [restoreHold] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    sql`${issueRecoveryActions.evidence}->>'workspaceRestoreFailure' = 'restore_unsafe_archive'`,
  )).orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  // A persisted user /new is an ordered context command, not a retry of uncertain work.
  // The normal issue execution lock still serializes it behind any active turn.
  if (!restoreHold && conversation?.agentId && options?.conversationResetCommentId) {
    const [command] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, options.conversationResetCommentId),
    )).limit(1);
    if (command?.authorUserId && !command.deletedAt && command.body.trim() === "/new") return null;
  }
  const [boundary] = conversation?.agentId && conversation.boundaryId
    ? await db.select({ createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.id, conversation.boundaryId),
    )).limit(1) : [];

  const ownership = await getConversationOwnershipBlocker(db, companyId, issueId);
  if (ownership) return { ...ownership, recoveryActionId: null };
  const [action] = restoreHold ? [restoreHold] : await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    executionBlockerPredicate(),
    boundary ? gt(issueRecoveryActions.createdAt, boundary.createdAt) : undefined,
  )).orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id)).limit(1);
  if (!action) return null;
  const parsedRunId = z.string().guid().safeParse(action.evidence.runId ?? action.evidence.sourceRunId);
  const runId = parsedRunId.success ? parsedRunId.data : null;
  const [run] = runId ? await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1) : [];

  return {
    recoveryActionId: action.id,
    runId,
    // A stopped reviewer can differ from the task owner who receives the work back.
    agentId: run?.agentId ?? null,
    cause: action.cause,
    nextAction: action.nextAction,
  };
}
