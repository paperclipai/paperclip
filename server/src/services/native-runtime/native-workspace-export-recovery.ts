import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity } from "../activity-log.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

const scanCursors = new WeakMap<Db, string>();

/** Repair only the historical generic-sweeper misclassification, without reopening work. */
export async function restoreNativeWorkspaceExportRepairs(db: Db, runIds?: string[]) {
  const selectCandidates = (cursor?: string) => db.select({ action: issueRecoveryActions }).from(issueRecoveryActions)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, issueRecoveryActions.companyId),
      sql`${nativeRunFinalizations.runId}::text = ${issueRecoveryActions.evidence}->>'runId'`))
    .where(and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.ownerType, "board"), eq(issueRecoveryActions.kind, "active_run_watchdog"),
      eq(issueRecoveryActions.cause, "native_workspace_sync_out_unsafe_archive"), eq(issueRecoveryActions.resolutionNote, "new_source_execution_path"),
      eq(nativeRunFinalizations.phase, "terminal_failure"), eq(nativeRunFinalizations.failureCode, "native_workspace_sync_out_unsafe_archive"),
      ...(runIds?.length ? [inArray(nativeRunFinalizations.runId, runIds)] : []),
      ...(cursor ? [gt(issueRecoveryActions.id, cursor)] : []))).orderBy(asc(issueRecoveryActions.id)).limit(25);
  let candidates = await selectCandidates(runIds?.length ? undefined : scanCursors.get(db));
  if (candidates.length === 0 && !runIds?.length && scanCursors.has(db)) {
    scanCursors.delete(db);
    candidates = await selectCandidates();
  }
  for (const { action: candidate } of candidates) {
    if (!runIds?.length) scanCursors.set(db, candidate.id);
    const publication = await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.sourceIssueId))).for("update");
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, String(candidate.evidence.runId)), eq(nativeRunFinalizations.issueId, candidate.sourceIssueId))).for("update");
      if (!issue || !coordinator || issue.status !== "blocked" || coordinator.phase !== "terminal_failure"
        || coordinator.failureCode !== candidate.cause || !coordinator.resultId || coordinator.leaseOwner) return null;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, coordinator.runId))).limit(1);
      if (!run || run.status !== "failed" || run.runtimeMode !== "native" || issue.assigneeAgentId !== run.agentId
        || (issue.executionRunId && issue.executionRunId !== run.id) || (issue.checkoutRunId && issue.checkoutRunId !== run.id)) return null;
      const [result] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(eq(nativeRunResults.companyId, run.companyId), eq(nativeRunResults.runId, run.id), eq(nativeRunResults.issueId, issue.id), eq(nativeRunResults.completionContractId, run.completionContractId ?? "00000000-0000-0000-0000-000000000000"), eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
      const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
      if (!result || !reference || reference.state !== "prepared" || reference.resourceDisposition === "destroy") return null;
      const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, reference.leaseId))).limit(1);
      if (!lease || lease.heartbeatRunId !== run.id || lease.issueId !== issue.id || lease.providerLeaseId !== reference.providerLeaseId
        || !hasRemoteTerminationReceipt(lease) || (lease.metadata?.remoteExecutionTermination as { state?: string })?.state !== "stopped") return null;
      const [anotherLease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!), eq(environmentLeases.status, "active"))).limit(1);
      const [newerRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id), or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`), or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])))).limit(1);
      const [otherAction] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id), inArray(issueRecoveryActions.status, ["active", "escalated"]))).limit(1);
      if (anotherLease || newerRun || otherAction) return null;
      const [restored] = await tx.update(issueRecoveryActions).set({ status: "active", outcome: null, resolvedAt: null, resolutionNote: null,
        evidence: { ...candidate.evidence, repairedAutomaticResolution: { reason: "new_source_execution_path", resolvedAt: candidate.resolvedAt?.toISOString() } },
        nextAction: "Repair the unsafe link or path in the retained sandbox, then choose Retry workspace export without submitting another provider turn. The accepted result is preserved.", wakePolicy: null, updatedAt: new Date() })
        .where(and(eq(issueRecoveryActions.id, candidate.id), eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.resolutionNote, "new_source_execution_path"))).returning({ id: issueRecoveryActions.id });
      if (!restored) return null;
      return persistActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "native-finalization", action: "issue.workspace_export_repair_restored", entityType: "issue", entityId: issue.id, runId: run.id, details: { recoveryActionId: restored.id, resultId: result.id } });
    });
    if (publication) publishActivity(publication.publication);
  }
}
