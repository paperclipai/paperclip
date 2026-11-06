import { and, desc, eq, sql } from "drizzle-orm";
import { agents, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations,
  nativeRunResults, statusDecisions, workAssessments, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import type { NativeControllerIdentity } from "./native-restart-recovery.js";
import { currentNativeWorkspaceRecoveryResult } from "./native-workspace-recovery-binding.js";
import { nativeWorkspaceFinalizationOwnerCanUpgrade } from "./native-workspace-finalization-ownership.js";
import { currentWorkspaceWorker, workspaceWorkerStopProofSupported } from "./native-workspace-platform-proof.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";

/** Observe the existing result/workspace recovery owners. This never claims a lease or stops a worker. */
export async function readNativeFinalizationUpgradeReadiness(db: Db, input: {
  companyId: string; runId: string; controller: NativeControllerIdentity; supportedOutageMs: number;
}): Promise<boolean> {
  const worker = currentWorkspaceWorker();
  if (!workspaceWorkerStopProofSupported(worker)) return false;
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '2s'`);
    const [row] = await tx.select({
      run: { id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
        nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode, nativePhase: heartbeatRuns.nativePhase, completionContractId: heartbeatRuns.completionContractId,
        createdAt: heartbeatRuns.createdAt,
        contextSnapshot: sql<Record<string, unknown>>`jsonb_strip_nulls(jsonb_build_object(
          'nativeReviewInteractionId', ${heartbeatRuns.contextSnapshot}->'nativeReviewInteractionId',
          'nativeReviewDecisionId', ${heartbeatRuns.contextSnapshot}->'nativeReviewDecisionId'))`,
        runnerProfileJson: sql<Record<string, unknown>>`jsonb_build_object(
          'remoteWorkspace', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace',
          'nativeWorkspaceSync', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is not null
            and ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' <> 'null'::jsonb,
          'nativeWorkspaceFinalizationOwner', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner')` },
      coordinator: { companyId: nativeRunFinalizations.companyId, issueId: nativeRunFinalizations.issueId,
        runId: nativeRunFinalizations.runId, phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId,
        controllerBootId: nativeRunFinalizations.controllerBootId, controllerPid: nativeRunFinalizations.controllerPid,
        controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt, controllerGeneration: nativeRunFinalizations.controllerGeneration,
        leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
        assessmentId: nativeRunFinalizations.assessmentId, decisionId: nativeRunFinalizations.decisionId },
      issue: { id: issues.id, companyId: issues.companyId, status: issues.status, executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId, assigneeAgentId: issues.assigneeAgentId, executionWorkspaceId: issues.executionWorkspaceId },
      adapter: agents.adapterType,
    })
      .from(heartbeatRuns).innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, heartbeatRuns.companyId)))
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
    if (!row) return false;
    const { run, coordinator, issue } = row;
    if (run.runtimeMode !== "native" || run.status !== "running" || row.adapter !== "paperclip_runner"
      || isNativeRunnerOwnershipHeld(run) || !coordinator.resultId || run.nativeIssueId !== issue.id
      || coordinator.controllerBootId !== input.controller.bootId || coordinator.controllerPid !== input.controller.pid
      || coordinator.controllerProcessStartedAt?.getTime() !== input.controller.processStartedAt.getTime()
      || coordinator.controllerGeneration < 1
      || !["result_accepted", "workspace_finalizing", "retryable_failure", "committed"].includes(coordinator.phase)) return false;
    // SIGTERM releases an accepted execution lease, but preserves an in-progress finalizer's lease.
    if (coordinator.leaseOwner?.startsWith("native-finalizer:") && coordinator.leaseExpiresAt
      && coordinator.leaseExpiresAt.getTime() > Date.now() + input.supportedOutageMs) return false;
    const profile = run.runnerProfileJson;
    const reference = remoteWorkspaceRunReferenceSchema.safeParse(profile?.remoteWorkspace);
    if (!reference.success || profile.nativeWorkspaceSync === true
      || !nativeWorkspaceFinalizationOwnerCanUpgrade(profile, input.controller, worker)) return false;
    const remote = reference.data;
    const [workspace] = await tx.select({ id: executionWorkspaces.id, providerType: executionWorkspaces.providerType,
      metadata: sql<Record<string, unknown>>`jsonb_build_object('remoteWorkspace', ${executionWorkspaces.metadata}->'remoteWorkspace')` })
      .from(executionWorkspaces).where(and(eq(executionWorkspaces.id, remote.workspaceId),
      eq(executionWorkspaces.companyId, input.companyId))).limit(1);
    if (!workspace || workspace.providerType !== "cloud_sandbox") return false;
    let authority;
    try { authority = readRemoteWorkspaceAuthority(workspace.metadata); } catch { return false; }
    if (!authority) return false;
    const [barrier] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(eq(workspaceOperations.companyId, input.companyId),
      eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.issueId, issue.id),
      eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "succeeded"))).orderBy(desc(workspaceOperations.createdAt)).limit(1);
    const [result] = await tx.select({ id: nativeRunResults.id, completionContractId: nativeRunResults.completionContractId,
      terminalState: sql<string>`${nativeRunResults.resultJson}->'terminal'->>'runTerminalState'` }).from(nativeRunResults).where(and(eq(nativeRunResults.id, coordinator.resultId),
      eq(nativeRunResults.companyId, input.companyId), eq(nativeRunResults.runId, run.id), eq(nativeRunResults.issueId, issue.id),
      eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
    if (!result || result.completionContractId !== run.completionContractId) return false;
    if (!["succeeded", "failed", "cancelled"].includes(result.terminalState)) return false;
    if (coordinator.phase === "committed") {
      if (!barrier || !coordinator.decisionId || !coordinator.assessmentId) return false;
      const [decision] = await tx.select({ id: statusDecisions.id }).from(statusDecisions).innerJoin(workAssessments,
        and(eq(workAssessments.id, statusDecisions.assessmentId), eq(workAssessments.companyId, statusDecisions.companyId),
          eq(workAssessments.issueId, statusDecisions.issueId), eq(workAssessments.runId, statusDecisions.runId)))
        .where(and(eq(statusDecisions.id, coordinator.decisionId), eq(statusDecisions.companyId, input.companyId),
          eq(statusDecisions.issueId, issue.id), eq(statusDecisions.runId, run.id), eq(statusDecisions.applicationState, "applied"),
          eq(workAssessments.id, coordinator.assessmentId), eq(workAssessments.resultId, result.id),
          eq(workAssessments.contractId, result.completionContractId))).limit(1);
      return Boolean(decision);
    }
    if (!await currentNativeWorkspaceRecoveryResult(tx as unknown as Db, { companyId: input.companyId, run, coordinator, issue })) return false;
    if (barrier) return true;
    const location = authority.location;
    if (!location || authority.writerRunId !== run.id || authority.epoch !== remote.epoch || location.leaseId !== remote.leaseId
      || location.providerLeaseId !== remote.providerLeaseId || location.remoteCwd !== remote.remoteCwd
      || issue.executionWorkspaceId !== workspace.id) return false;
    const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).innerJoin(environments,
      eq(environments.id, environmentLeases.environmentId)).where(and(eq(environmentLeases.id, location.leaseId),
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.environmentId, location.environmentId),
      eq(environmentLeases.executionWorkspaceId, workspace.id), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.issueId, issue.id), eq(environmentLeases.providerLeaseId, location.providerLeaseId),
      eq(environments.driver, "sandbox"), eq(environments.status, "active"),
      sql`${environmentLeases.status} not in ('expired', 'failed', 'pending_cleanup')`,
      sql`${environmentLeases.releasedAt} is null and ${environmentLeases.cleanupStatus} is null`,
      sql`(${environmentLeases.expiresAt} is null or ${environmentLeases.expiresAt} > clock_timestamp())`)).limit(1);
    return Boolean(lease);
  }, { accessMode: "read only" });
}
