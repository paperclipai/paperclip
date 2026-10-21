import { and, desc, eq, gte, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { readSystemRecovery } from "./system-recovery-state.js";

/** Re-enter the existing finalizer only after preservation. This does not
 * recreate a result, grant an executor budget, or apply it over newer work. */
export async function resumePreservedResultFinalization(db: Db, companyId: string, runId: string) {
  return db.transaction(async tx => {
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId),
    )).for("update");
    if (!coordinator?.resultId || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner ||
        coordinator.failureDetail?.successorRunId) return false;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, coordinator.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.id, runId))).for("update");
    if (!issue || !run || issue.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(issue.status) ||
        issue.executionRunId || issue.checkoutRunId) return false;
    const [newer] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), ne(heartbeatRuns.id, runId),
      or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
      gte(heartbeatRuns.createdAt, run.createdAt),
    )).limit(1);
    if (newer) return false;
    const [result] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.issueId, issue.id),
      eq(nativeRunResults.runId, runId), eq(nativeRunResults.id, coordinator.resultId),
      eq(nativeRunResults.schemaStatus, "accepted"),
      sql`${nativeRunResults.resultJson}#>>'{terminal,runTerminalState}' = 'succeeded'`,
    ));
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
    )).orderBy(desc(issueRecoveryActions.createdAt)).limit(1);
    const recovery = readSystemRecovery(action?.evidence);
    if (!result || recovery?.state !== "complete" || !recovery.preservationOperationIds.length) return false;
    const [intent] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.reason, "task_retry"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${runId}`,
    )).orderBy(desc(agentWakeupRequests.requestedAt)).limit(1);
    const generationId = intent?.id ?? recovery.generationId;
    if (coordinator.recoveryHistory.some(entry => entry.kind === "preserved_result_finalization" &&
        entry.generationId === generationId)) return false;
    await tx.update(nativeRunFinalizations).set({
      phase: coordinator.assessmentId ? "arbitrating" : "workspace_finalizing",
      nextAttemptAt: new Date(), failureCode: null, failureDetail: null, updatedAt: new Date(),
      recoveryHistory: [...coordinator.recoveryHistory, {
        kind: "preserved_result_finalization", generationId,
        resultId: result.id, previousFailureCode: coordinator.failureCode,
        previousFailureDetail: coordinator.failureDetail, at: new Date().toISOString(),
      }],
    }).where(eq(nativeRunFinalizations.runId, runId));
    if (intent) await tx.update(agentWakeupRequests).set({
      status: "coalesced", runId, finishedAt: new Date(), updatedAt: new Date(),
      payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{taskRetry,strategy}', '"finalize_result"'::jsonb)`,
    }).where(eq(agentWakeupRequests.id, intent.id));
    return true;
  });
}
