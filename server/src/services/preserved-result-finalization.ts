import { notifyNativeFinalizationWork } from "./native-finalization-notifications.js";
import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { readSystemRecovery } from "./system-recovery-state.js";
import { preservedResultHasStop } from "./native-runtime/preserved-native-result-finalization.js";
import { readWorkspaceRecovery, verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/** The durable facts that let a terminal run's accepted result be applied once
 * its files are saved: the coordinator names an accepted, succeeded result of
 * this run; the run's own saved-work recovery completed with a verified receipt;
 * nobody stopped the run; and no newer run, owner or applied generation exists.
 * Any missing or contradicting fact returns null, so callers keep their existing
 * behaviour. `lock` takes the row locks that resumption needs. */
async function readPreservedResult(db: Db, companyId: string, runId: string, lock: boolean) {
  const coordinatorQuery = () => db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)));
  // Dispatch locks the issue before the coordinator and run. Take locks in the
  // same order, so a Retry admission and this resumption cannot deadlock.
  const [unlocked] = await coordinatorQuery();
  if (!unlocked) return null;
  const issueQuery = db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, unlocked.issueId)));
  const [issue] = lock ? await issueQuery.for("update") : await issueQuery;
  const [coordinator] = lock ? await coordinatorQuery().for("update") : [unlocked];
  if (!coordinator?.resultId || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner ||
      coordinator.failureDetail?.successorRunId || coordinator.issueId !== unlocked.issueId) return null;
  const runQuery = db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  const [run] = lock ? await runQuery.for("update") : await runQuery;
  if (!issue || !run || run.status === "cancelled" || preservedResultHasStop(run.resultJson)
      || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId || ["done", "cancelled"].includes(issue.status) ||
      issue.executionRunId || issue.checkoutRunId) return null;
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, runId),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    gte(heartbeatRuns.createdAt, run.createdAt),
  )).limit(1);
  if (newer) return null;
  const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issue.id),
    eq(nativeRunResults.runId, runId), eq(nativeRunResults.id, coordinator.resultId),
    eq(nativeRunResults.schemaStatus, "accepted"),
    sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'succeeded'`,
  ));
  const [action] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
  )).orderBy(desc(issueRecoveryActions.createdAt)).limit(1);
  const recovery = readSystemRecovery(action?.evidence);
  const workspace = readWorkspaceRecovery(action?.evidence ?? null);
  if (!result || recovery?.state !== "complete" || recovery.sourceRunId !== run.id || !recovery.preservationOperationIds.length
    || workspace?.status !== "recovered" || workspace.runId !== run.id
    || !await verifiedWorkspaceRepairReceipt(db, run)) return null;
  const [intent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.reason, "task_retry"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${runId}`,
  )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
  const generationId = intent?.id ?? recovery.generationId;
  if (coordinator.recoveryHistory.some(entry => entry.kind === "preserved_result_finalization" &&
      entry.generationId === generationId)) return null;
  return { coordinator, issue, run, result, recovery, intent, generationId };
}

/** Read-only: whether resumePreservedResultFinalization would apply this run's
 * saved accepted result now. Retry admission uses it to wait for that result
 * instead of starting a new agent turn. It takes no locks and changes nothing. */
export async function canResumePreservedResultFinalization(db: Db, companyId: string, runId: string) {
  return (await readPreservedResult(db, companyId, runId, false)) !== null;
}

/** Re-enter the existing finalizer only after preservation. This does not
 * recreate a result, grant an executor budget, or apply it over newer work. */
export async function resumePreservedResultFinalization(db: Db, companyId: string, runId: string) {
  const resumed = await db.transaction(async tx => {
    const found = await readPreservedResult(tx as unknown as Db, companyId, runId, true);
    if (!found) return null;
    const { coordinator, issue, run, result, recovery, intent, generationId } = found;
    await notifyNativeFinalizationWork(tx, { companyId, runId });
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.assessmentId ? "arbitrating" : "workspace_finalizing",
      nextAttemptAt: new Date(), failureCode: null, failureDetail: null, updatedAt: new Date(),
      recoveryHistory: [...coordinator.recoveryHistory, {
        kind: "preserved_result_finalization", generationId,
        preservationGenerationId: recovery.generationId,
        resultId: result.id, previousFailureCode: coordinator.failureCode,
        previousFailureDetail: coordinator.failureDetail, at: new Date().toISOString(),
      }],
    }).where(eq(nativeRunFinalizations.runId, runId));
    if (intent) await tx.update(agentWakeupRequests).set({
      status: "coalesced", runId, finishedAt: new Date(), updatedAt: new Date(),
      payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"finalize_result"'::jsonb)`,
    }).where(eq(agentWakeupRequests.id, intent.id));
    return persistActivity(tx as unknown as Db, { companyId, actorType: "system", actorId: "task-recovery",
      action: "issue.saved_result_finalization_resumed", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { resultId: result.id, preservationGenerationId: recovery.generationId,
        ...(intent ? { requestId: intent.id, strategy: "finalize_result" } : {}) } });
  });
  if (!resumed) return false;
  try { publishActivity(resumed.publication); } catch { logger.warn({ runId }, "Saved result activity delivery deferred"); }
  return true;
}
