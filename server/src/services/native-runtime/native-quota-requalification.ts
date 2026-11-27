import { and, asc, eq, gt, gte, inArray, ne, or, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueRecoveryActions, type issues, type Db } from "@paperclipai/db";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "../recovery/continuation-ledger.js";
import { boundRunIssueIdSql } from "../run-task-binding.js";

export const UNCERTAIN_PROVIDER_ACTION = "uncertain_provider_action";
type ReplacementTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RecoveryHold = typeof issueRecoveryActions.$inferSelect;
type Task = typeof issues.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const activeHold = (hold: RecoveryHold) => hold.status === "active" || hold.status === "escalated";
export function blockBelongsToRun(hold: RecoveryHold, runId: string, statusVersion: number) {
  const receipt = record(hold.evidence.nativeFailureBlock);
  return receipt.runId === runId && receipt.statusVersion === statusVersion;
}

/** Identify the precise denial you can retire in the successor transaction.
 * The caller holds the task and finalization locks. */
export async function requalifiableQuotaHold(tx: ReplacementTx, run: Run, task: Task): Promise<RecoveryHold | null> {
  if (task.status !== "blocked" || task.assigneeUserId || task.hiddenAt || task.unblockDescriptor) return null;
  const fingerprint = `native-replacement:${run.id}`;
  const holds = await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.fingerprint, fingerprint)),
  )).for("update");
  const exact = holds.filter(hold => hold.kind === "active_run_watchdog" && hold.fingerprint === fingerprint &&
    hold.cause === UNCERTAIN_PROVIDER_ACTION && hold.ownerType === "board" && hold.returnOwnerAgentId === run.agentId &&
    hold.evidence.runId === run.id && !Object.hasOwn(hold.evidence, "explicitUserContinuation") &&
    !Object.hasOwn(hold.evidence, "executionReconciliation"));
  if (exact.length !== 1 || holds.some(hold => activeHold(hold) && hold.id !== exact[0]!.id)) return null;
  const hold = exact[0]!;
  const automatic = record(hold.evidence.automaticRecovery);
  if (!activeHold(hold) && !(hold.status === "resolved" && hold.outcome === "blocked" && automatic.runId === run.id &&
      automatic.policy === "preserve_without_replay_v1" && automatic.replay === "blocked" && automatic.actionOutcome === "unknown")) return null;

  const [later] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), sql`${boundRunIssueIdSql()} = ${task.id}`,
    ne(heartbeatRuns.id, run.id), gte(heartbeatRuns.createdAt, run.createdAt),
  )).limit(1);
  if (later) return null;
  const [newerHold] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    ne(issueRecoveryActions.id, hold.id), gte(issueRecoveryActions.createdAt, hold.createdAt),
  )).limit(1);
  if (newerHold) return null;
  const [operatorChange] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, task.id),
    eq(activityLog.actorType, "user"), gt(activityLog.createdAt, hold.createdAt),
  )).limit(1);
  if (operatorChange) return null;
  const [wake] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
    sql`coalesce(${agentWakeupRequests.payload}->>'issueId', ${agentWakeupRequests.payload}->>'taskId') = ${task.id}`,
  )).limit(1);
  return wake ? null : hold;
}

/** The assigned-work sweep may temporarily lift an unexplained block and then
 * restore it when no execution is admitted. Its charged status transitions
 * preserve the original block. Explain every status version before accepting
 * that older receipt. A task decision or other attributed change fences it. */
export async function quotaBlockRestoredByAssignedWorkSweep(
  tx: ReplacementTx, run: Run, task: Task, denial: RecoveryHold, originalHolds: RecoveryHold[],
) {
  if (denial.status !== "resolved" || !denial.resolvedAt || task.lastStatusDecisionId) return false;
  const originals = originalHolds.filter(hold => {
    const receipt = record(hold.evidence.nativeFailureBlock);
    return receipt.runId === run.id && typeof receipt.statusVersion === "number";
  });
  if (originals.length !== 1) return false;
  const original = originals[0]!;
  if (!task.blockedTransitionAt || task.blockedTransitionAt < original.createdAt || task.blockedTransitionAt > denial.resolvedAt) return false;
  const initialVersion = Number(record(original.evidence.nativeFailureBlock).statusVersion);
  const refusalCount = (task.statusVersion - initialVersion) / 2;
  if (!Number.isSafeInteger(refusalCount) || refusalCount < 1 || refusalCount > 25) return false;
  const changes = await tx.select({ actorType: activityLog.actorType, actorId: activityLog.actorId,
    agentId: activityLog.agentId, runId: activityLog.runId, action: activityLog.action,
    details: activityLog.details, createdAt: activityLog.createdAt,
  }).from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, task.id),
    gt(activityLog.createdAt, original.createdAt),
    or(eq(activityLog.actorType, "user"), eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION),
      sql`${activityLog.details} ?| array['status', 'toStatus', 'assigneeAgentId', 'assigneeUserId']`),
  )).orderBy(asc(activityLog.createdAt)).limit(refusalCount + 1);
  return changes.length === refusalCount && changes.every((change, index) => {
    const details = record(change.details);
    return change.actorType === "system" && change.actorId === "system" && change.agentId === run.agentId &&
      change.runId === null && change.action === ASSIGNED_WORK_CONTINUED_ACTION && change.createdAt > denial.resolvedAt! &&
      details.previousStatus === "blocked" && details.status === "todo" && details.violation === "unknown_block" &&
      details.outcome === "not_started" && details.attempt === index + 1;
  });
}
