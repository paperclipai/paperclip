import { and, desc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, executionWorkspaces, executionWorkspaceSnapshots,
  heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { hasRequiredWorkspaceRecovery, nativeRunHasNoWorkspaceAccess } from "../workspace-restore-recovery-state.js";
import { preserveNativeFailedWorkspace } from "./native-failed-workspace-recovery.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

type RetirementInput = {
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect;
  issueExecutionRunId: string | null;
  now: Date;
};

async function completedIsolatedRetry(db: Db, { run, coordinator, now }: RetirementInput) {
  if (coordinator.phase !== "observed" || run.runnerProfileJson?.nativeWorkspaceSync != null
    || (coordinator.leaseOwner && !coordinator.leaseExpiresAt)
    || (coordinator.leaseExpiresAt && coordinator.leaseExpiresAt > now)
    || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)) return null;
  const remote = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!remote.success || remote.data.state !== "prepared") return null;
  const reference = remote.data;
  const [sourceWorkspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId),
    eq(executionWorkspaces.sourceIssueId, coordinator.issueId), eq(executionWorkspaces.providerType, "cloud_sandbox"),
  )).limit(1).for("update");
  const source = readRemoteWorkspaceAuthority(sourceWorkspace?.metadata);
  if (!source?.dirty || source.writerRunId !== run.id || source.epoch !== reference.epoch
    || source.location?.leaseId !== reference.leaseId || source.location.providerLeaseId !== reference.providerLeaseId
    || source.location.remoteCwd !== reference.remoteCwd) return null;

  const [current] = await db.select({ workspace: executionWorkspaces, successorId: heartbeatRuns.id,
    remote: sql<unknown>`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'` })
    .from(issues)
    .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.companyId, issues.companyId),
      eq(executionWorkspaces.id, issues.executionWorkspaceId), eq(executionWorkspaces.sourceIssueId, issues.id)))
    .innerJoin(agentWakeupRequests, and(eq(agentWakeupRequests.companyId, issues.companyId),
      eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.id, executionWorkspaces.id),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "coalesced"),
      eq(agentWakeupRequests.requestedByActorType, "user"), gt(agentWakeupRequests.requestedAt, run.finishedAt!),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issues.id}::text`,
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,schema}' = 'paperclip.task-retry.v1'`,
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,generationId}' = ${agentWakeupRequests.id}::text`,
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,actorId}' = ${agentWakeupRequests.requestedByActorId}`,
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,strategy}' = 'fresh_isolated_workspace'`))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issues.companyId),
      eq(heartbeatRuns.id, agentWakeupRequests.runId), eq(heartbeatRuns.agentId, run.agentId),
      eq(heartbeatRuns.nativeIssueId, issues.id), eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.nativePhase, "committed"),
      gt(heartbeatRuns.startedAt, agentWakeupRequests.requestedAt), isNotNull(heartbeatRuns.finishedAt),
      sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${agentWakeupRequests.id}::text`,
      sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
      sql`(${heartbeatRuns.retryOfRunId} is null or
        ${heartbeatRuns.retryOfRunId}::text = ${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}')`,
      sql`exists (select 1 from heartbeat_runs retry_parent
        where retry_parent.id::text = ${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'
        and retry_parent.company_id = ${run.companyId} and retry_parent.agent_id = ${run.agentId}
        and coalesce(retry_parent.native_issue_id::text, retry_parent.issue_id::text,
          retry_parent.context_snapshot->>'issueId') = ${issues.id}::text
        and retry_parent.status = 'failed' and retry_parent.finished_at <= ${agentWakeupRequests.requestedAt})`))
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, run.companyId),
      eq(nativeRunFinalizations.issueId, issues.id), eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.phase, "committed")))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.companyId, run.companyId),
      eq(nativeRunResults.issueId, issues.id), eq(nativeRunResults.runId, heartbeatRuns.id),
      eq(nativeRunResults.id, nativeRunFinalizations.resultId), eq(nativeRunResults.schemaStatus, "accepted")))
    .innerJoin(executionWorkspaceSnapshots, and(eq(executionWorkspaceSnapshots.companyId, run.companyId),
      eq(executionWorkspaceSnapshots.executionWorkspaceId, executionWorkspaces.id),
      eq(executionWorkspaceSnapshots.sourceRunId, heartbeatRuns.id), eq(executionWorkspaceSnapshots.status, "committed"),
      sql`${executionWorkspaceSnapshots.id}::text = ${executionWorkspaces.metadata}#>>'{remoteWorkspace,snapshotId}'`,
      sql`${executionWorkspaceSnapshots.epoch}::text = ${executionWorkspaces.metadata}#>>'{remoteWorkspace,epoch}'`))
    .where(and(eq(issues.companyId, run.companyId), eq(issues.id, coordinator.issueId),
      eq(issues.assigneeAgentId, run.agentId), sql`${issues.executionRunId} is null and ${issues.checkoutRunId} is null`,
      sql`${executionWorkspaces.id} <> ${reference.workspaceId}::uuid`, eq(executionWorkspaces.providerType, "cloud_sandbox"),
      eq(executionWorkspaces.mode, "isolated_workspace"),
      sql`not exists (select 1 from heartbeat_runs active_run where active_run.company_id = ${run.companyId}
        and coalesce(active_run.native_issue_id::text, active_run.issue_id::text,
          active_run.context_snapshot->>'issueId') = ${issues.id}::text
        and active_run.status in ('queued', 'running', 'scheduled_retry'))`,
      sql`not exists (select 1 from native_run_results prior_result where prior_result.company_id = ${run.companyId}
        and prior_result.run_id = ${run.id} and prior_result.schema_status = 'accepted')`)).limit(1);
  const saved = remoteWorkspaceRunReferenceSchema.safeParse(current?.remote);
  const authority = readRemoteWorkspaceAuthority(current?.workspace.metadata);
  if (!current || !saved.success || saved.data.state !== "saved" || !authority || authority.dirty || authority.writerRunId
    || saved.data.workspaceId !== current.workspace.id || saved.data.epoch !== authority.epoch
    || saved.data.snapshotId !== authority.snapshotId || current.workspace.cwd !== saved.data.remoteCwd
    || authority.location?.leaseId !== saved.data.leaseId || authority.location.providerLeaseId !== saved.data.providerLeaseId
    || authority.location.remoteCwd !== saved.data.remoteCwd) return null;
  return { id: current.successorId, reference, environmentId: source.location.environmentId };
}

export async function retireSupersededNativeRetry(db: Db, input: RetirementInput): Promise<boolean> {
  const { run, coordinator, now } = input;
  if (run.runtimeMode !== "native" || run.status !== "failed" || !run.startedAt || !run.finishedAt
    || coordinator.resultId
    || coordinator.companyId !== run.companyId || coordinator.issueId !== run.nativeIssueId
    || coordinator.runId !== run.id || input.issueExecutionRunId === run.id
    || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner || nativeRunHasNoWorkspaceAccess(run)) return false;
  const isolated = await completedIsolatedRetry(db, input);
  if (!isolated && (run.processPid !== null || run.processGroupId !== null
    || coordinator.phase !== "retryable_failure" || coordinator.leaseOwner)) return false;
  const reference = isolated?.reference ?? readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (reference?.state !== "prepared") return false;

  const [linkedSuccessor] = isolated ? [] : await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.nativeIssueId, coordinator.issueId),
    eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.runtimeMode, "native"),
    eq(heartbeatRuns.status, "succeeded"), eq(heartbeatRuns.nativePhase, "committed"),
    gt(heartbeatRuns.startedAt, run.finishedAt), isNotNull(heartbeatRuns.finishedAt),
    sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${run.id}`,
    sql`nullif(${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId', '') is not null`,
  )).orderBy(desc(heartbeatRuns.startedAt)).limit(1);
  const successor = isolated ?? linkedSuccessor;
  if (!successor) return false;
  const [source] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.companyId, run.companyId),
    eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.issueId, coordinator.issueId),
    eq(environmentLeases.providerLeaseId, reference.providerLeaseId),
    ...(isolated ? [eq(environmentLeases.status, "active"), eq(environmentLeases.environmentId, isolated.environmentId),
      eq(environmentLeases.executionWorkspaceId, reference.workspaceId),
      or(isNull(environmentLeases.expiresAt), gt(environmentLeases.expiresAt, now))] : []),
    sql`${environmentLeases.metadata}->>'remoteCwd' = ${reference.remoteCwd}`,
    sql`(${environmentLeases.executionWorkspaceId} is null or ${environmentLeases.executionWorkspaceId}::text = ${reference.workspaceId})`,
  )).limit(1).for("update");
  if (!source) return false;

  await notifyExecutionRunWork(db, { companyId: run.companyId });
  await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", nextAttemptAt: null, leaseOwner: null,
    leaseExpiresAt: null, controlDeadlineAt: null, recoveryState: "blocked",
    failureCode: "native_retry_superseded", failureDetail: { ...coordinator.failureDetail,
      reason: "completed_explicit_retry", successorRunId: successor.id }, updatedAt: now,
  }).where(eq(nativeRunFinalizations.runId, run.id));
  const [retired] = await db.update(heartbeatRuns).set({ nativePhase: "terminal_failure",
    nativePhaseUpdatedAt: now, updatedAt: now,
  }).where(eq(heartbeatRuns.id, run.id)).returning();
  const preserved = await preserveNativeFailedWorkspace(db, retired!);
  if (!preserved || !hasRequiredWorkspaceRecovery(preserved.resultJson)) {
    throw new Error("superseded_native_retry_preservation_not_recorded");
  }
  return true;
}
