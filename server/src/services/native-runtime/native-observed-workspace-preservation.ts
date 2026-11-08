import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { companies, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { remoteWorkspaceAuthoritySchema, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { logActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { recordRequiredWorkspaceRestoreFailure } from "../legacy-execution-recovery.js";
import { notifyNativeEnvironmentSettlement } from "../native-environment-settlement-notifications.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain, hasStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";
import { nativeSha256 } from "./canonical.js";
import { NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT, NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE } from "./native-runner-ownership.js";

const SCHEMA = "paperclip.observed-workspace-preservation.v1";
const FIELD = "observedWorkspacePreservation";
type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
type Fence = { schema: typeof SCHEMA; state: "stop_pending" | "stopped"; runId: string;
  leaseOwner: string; leaseExpiresAt: string; controllerGeneration: number; providerAttempt: number; sourceSha256: string; coordinatorSha256: string;
  leaseId: string; provider: string; providerLeaseId: string; environmentId: string; workspaceId: string };

export class ObservedWorkspacePreservationBusyError extends Error {
  readonly code = "55P03";
  constructor(options?: ErrorOptions) { super("observed_workspace_preservation_busy", options); }
}

async function preservationTransaction<T>(db: Db, operation: (tx: Db) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
      return operation(tx);
    });
  } catch (error) {
    const failure = error as { code?: unknown; cause?: { code?: unknown } };
    if (failure?.code === "55P03" || failure?.cause?.code === "55P03") throw new ObservedWorkspacePreservationBusyError({ cause: error });
    throw error;
  }
}

function sourceSha256(run: Run) {
  const profile = run.runnerProfileJson ?? {};
  return nativeSha256({ runId: run.id, companyId: run.companyId, agentId: run.agentId, issueId: run.nativeIssueId,
    nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
    processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt?.toISOString() ?? null,
    remoteWorkspace: profile.remoteWorkspace, nativeExecutionInput: profile.nativeExecutionInput,
    sessionCheckpoint: profile.sessionCheckpoint, nativeControllerRecovery: profile.nativeControllerRecovery,
    errorCode: run.errorCode, error: run.error, finishedAt: run.finishedAt?.toISOString() ?? null });
}

function coordinatorSha256(coordinator: Coordinator) {
  return nativeSha256({ controllerBootId: coordinator.controllerBootId, controllerPid: coordinator.controllerPid,
    controllerProcessStartedAt: coordinator.controllerProcessStartedAt?.toISOString() ?? null,
    controllerGeneration: coordinator.controllerGeneration, attempt: coordinator.attempt,
    leaseOwner: coordinator.leaseOwner, leaseExpiresAt: coordinator.leaseExpiresAt?.toISOString() ?? null,
    phase: coordinator.phase, resultId: coordinator.resultId, recoveryState: coordinator.recoveryState,
    recoveryRequestId: coordinator.recoveryRequestId, recoveryHistory: coordinator.recoveryHistory,
    failureCode: coordinator.failureCode, failureDetail: coordinator.failureDetail,
    nextAttemptAt: coordinator.nextAttemptAt?.toISOString() ?? null, controlDeadlineAt: coordinator.controlDeadlineAt?.toISOString() ?? null });
}

function readFence(value: unknown): Fence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fence = value as Fence;
  return fence.schema === SCHEMA && ["stop_pending", "stopped"].includes(fence.state)
    && [fence.runId, fence.leaseOwner, fence.leaseId, fence.provider, fence.providerLeaseId, fence.environmentId, fence.workspaceId]
      .every(item => typeof item === "string" && Boolean(item))
    && Number.isFinite(Date.parse(fence.leaseExpiresAt)) && /^[a-f0-9]{64}$/.test(fence.sourceSha256) && /^[a-f0-9]{64}$/.test(fence.coordinatorSha256)
    && Number.isSafeInteger(fence.controllerGeneration) && fence.controllerGeneration >= 0
    && Number.isSafeInteger(fence.providerAttempt) && fence.providerAttempt >= 0 ? fence : null;
}

function matchesObserved(run: Run, coordinator: Coordinator | undefined, now: Date) {
  return run.runtimeMode === "native" && run.status === "failed" && run.nativePhase === "observed" && Boolean(run.nativeIssueId)
    && run.errorCode !== NATIVE_OWNERSHIP_UNVERIFIED_ERROR_CODE && run.errorCode !== NATIVE_ADOPTED_RUNNER_AUTHENTICATION_TIMEOUT
    && !adapterExecutionControls.has(run.id)
    && run.resultJson?.nativeCancellation == null && run.resultJson?.startupCancellation == null
    && run.resultJson?.executionCancellation == null && run.resultJson?.cancellation == null
    && !(run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > now)
    && run.runnerProfileJson?.nativeWorkspaceSync == null && run.runnerProfileJson?.nativeWorkspaceFinalizationOwner == null
    && coordinator?.companyId === run.companyId && coordinator.issueId === run.nativeIssueId
    && coordinator.runId === run.id && coordinator.phase === "observed" && coordinator.resultId === null
    && coordinator.assessmentId === null && coordinator.decisionId === null && coordinator.failureCode === null
    && coordinator.recoveryState === "awaiting_runner_reattach" && coordinator.nextAttemptAt === null && coordinator.controlDeadlineAt === null
    && Boolean(coordinator.leaseOwner) && Boolean(coordinator.leaseExpiresAt && coordinator.leaseExpiresAt <= now);
}

async function lockSource(db: Db, companyId: string, runId: string) {
  await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("key share", { noWait: true });
  const [identity] = await db.select({ issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  if (!identity?.issueId) return null;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, identity.issueId))).for("update", { noWait: true });
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId),
    eq(nativeRunFinalizations.issueId, identity.issueId))).for("update", { noWait: true });
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update", { noWait: true });
  if (!task || !run || task.status !== "blocked" || task.assigneeAgentId !== run.agentId || task.assigneeUserId
    || task.executionRunId || task.checkoutRunId || !matchesObserved(run, coordinator, new Date())) return null;
  const [accepted] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
    eq(nativeRunResults.companyId, companyId), eq(nativeRunResults.runId, runId), eq(nativeRunResults.schemaStatus, "accepted")))
    .limit(1).for("update", { noWait: true });
  if (accepted) return null;
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!parsed.success || parsed.data.state !== "prepared" || task.executionWorkspaceId !== parsed.data.workspaceId) return null;
  const reference = parsed.data;
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, reference.workspaceId))).for("update", { noWait: true });
  const parsedAuthority = remoteWorkspaceAuthoritySchema.safeParse(workspace?.metadata?.remoteWorkspace);
  const authority = parsedAuthority.success ? parsedAuthority.data : null;
  if (!workspace || workspace.sourceIssueId !== task.id || !authority?.location || authority.epoch !== reference.epoch
    || authority.snapshotId !== reference.snapshotId || !authority.dirty || authority.writerRunId !== run.id
    || authority.location.leaseId !== reference.leaseId || authority.location.providerLeaseId !== reference.providerLeaseId
    || authority.location.remoteCwd !== reference.remoteCwd) return null;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    inArray(workspaceOperations.status, ["pending", "running"]))).limit(1);
  if (operation) return null;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id))).orderBy(asc(environmentLeases.id));
  if (leases.length !== 1) return null;
  const selected = leases[0];
  if (!selected.provider || !selected.providerLeaseId) return null;
  const history = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.provider, selected.provider), eq(environmentLeases.providerLeaseId, selected.providerLeaseId)))
    .orderBy(asc(environmentLeases.id)).for("update", { noWait: true });
  if (history.length !== 1 || history[0].id !== selected.id) return null;
  const lease = history[0];
  if (lease.id !== reference.leaseId || lease.issueId !== task.id || lease.executionWorkspaceId !== workspace.id
    || lease.environmentId !== authority.location.environmentId || !lease.environmentId
    || !lease.provider || lease.provider === "local" || lease.providerLeaseId !== reference.providerLeaseId
    || lease.metadata?.remoteCwd !== reference.remoteCwd || lease.metadata?.agentId !== run.agentId
    || (lease.metadata?.pendingCleanupInFlight != null && lease.metadata.pendingCleanupInFlight !== false)) return null;
  const [writer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`(${heartbeatRuns.nativeIssueId} = ${task.id}::uuid or ${heartbeatRuns.issueId} = ${task.id}::uuid
      or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}
      or ${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${workspace.id})`)).limit(1);
  if (writer) return null;
  return { run, task, coordinator: coordinator!, reference, workspace, lease };
}

function fenceMatches(fence: Fence, source: NonNullable<Awaited<ReturnType<typeof lockSource>>>, evidence: Record<string, unknown> | undefined) {
  const { run, coordinator, lease } = source;
  const recorded = run.resultJson?.workspaceRestoreRecovery as { schema?: unknown; leaseIds?: unknown } | undefined;
  const action = evidence?.workspaceRestoreRecovery as { schema?: unknown; leaseIds?: unknown } | undefined;
  const retained = lease.metadata?.workspaceRestoreRecovery as { schema?: unknown; runId?: unknown } | undefined;
  const exact = (value: typeof recorded) => value?.schema === "paperclip.workspace-restore-recovery.v1"
    && Array.isArray(value.leaseIds) && value.leaseIds.length === 1 && value.leaseIds[0] === lease.id;
  return lease.leasePolicy === "retain_on_failure" && exact(recorded) && exact(action) && retained?.schema === "paperclip.workspace-restore-recovery.v1" && retained.runId === run.id
    && fence.runId === run.id && fence.sourceSha256 === sourceSha256(run) && fence.coordinatorSha256 === coordinatorSha256(coordinator)
    && fence.leaseOwner === coordinator.leaseOwner && fence.leaseExpiresAt === coordinator.leaseExpiresAt?.toISOString()
    && fence.controllerGeneration === coordinator.controllerGeneration && fence.providerAttempt === coordinator.attempt
    && fence.leaseId === lease.id && fence.provider === lease.provider && fence.providerLeaseId === lease.providerLeaseId
    && fence.environmentId === lease.environmentId && fence.workspaceId === source.workspace.id;
}

export async function pinFailedObservedWorkspace(db: Db, companyId: string, runId: string): Promise<boolean> {
  return preservationTransaction(db, async tx => {
    const source = await lockSource(tx, companyId, runId);
    if (!source) return false;
    const { run, task, coordinator, workspace, lease } = source;
    const [existing] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, task.id), eq(issueRecoveryActions.fingerprint, `native-workspace:${run.id}`))).for("update", { noWait: true });
    if (hasRequiredWorkspaceRecovery(run.resultJson)) {
      const fence = readFence(existing?.evidence[FIELD]);
      return Boolean(fence?.state === "stop_pending" && fenceMatches(fence, source, existing?.evidence));
    }
    const active = lease.leasePolicy === "ephemeral" && lease.status === "active" && lease.releasedAt === null && lease.cleanupStatus === null
      && !hasStopOnlyCleanup(lease) && lease.metadata?.sandboxStopAndRetainReceipt == null
      && lease.metadata?.remoteExecutionTermination == null && lease.metadata?.pendingCleanupAttemptId == null
      && (lease.metadata?.pendingCleanupLeaseExpiresAtMs == null || lease.metadata.pendingCleanupLeaseExpiresAtMs === 0)
      && lease.metadata?.workspaceRecoveryCleanup == null;
    if (!active) return false;
    await notifyNativeEnvironmentSettlement(tx, { companyId, runId, issueId: task.id });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.ownershipInvariantReport, JSON.stringify({ companyId, runId }));
    const retained = await recordRequiredWorkspaceRestoreFailure(tx, run, { workspaceRestoreFailure: "restore_failed" }, lease);
    if (!retained || !hasRequiredWorkspaceRecovery(retained.resultJson)) throw new Error("observed_workspace_retention_missing");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, task.id), eq(issueRecoveryActions.fingerprint, `native-workspace:${run.id}`))).for("update", { noWait: true });
    if (!action) throw new Error("observed_workspace_retention_action_missing");
    const fence: Fence = { schema: SCHEMA, state: "stop_pending", runId, leaseOwner: coordinator.leaseOwner!,
      leaseExpiresAt: coordinator.leaseExpiresAt!.toISOString(), controllerGeneration: coordinator.controllerGeneration,
      providerAttempt: coordinator.attempt, sourceSha256: sourceSha256(run), coordinatorSha256: coordinatorSha256(coordinator), leaseId: lease.id,
      provider: lease.provider!, providerLeaseId: lease.providerLeaseId!, environmentId: lease.environmentId!, workspaceId: workspace.id };
    await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, [FIELD]: fence }, updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, action.id)));
    await logActivity(tx, { companyId, actorType: "system", actorId: "native-workspace-recovery",
      action: "issue.observed_workspace_preservation_pinned", entityType: "issue", entityId: task.id, runId,
      details: { recoveryActionId: action.id, sourceRunId: runId, controllerGeneration: fence.controllerGeneration } });
    return true;
  });
}

export async function settleStoppedObservedWorkspace(db: Db, companyId: string, runId: string): Promise<boolean> {
  return preservationTransaction(db, async tx => {
    const source = await lockSource(tx, companyId, runId);
    if (!source) return false;
    const { run, task, coordinator, lease } = source;
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, task.id), eq(issueRecoveryActions.fingerprint, `native-workspace:${run.id}`))).for("update", { noWait: true });
    const fence = readFence(action?.evidence[FIELD]);
    if (!fence || fence.state !== "stop_pending" || !hasRequiredWorkspaceRecovery(run.resultJson)
      || !fenceMatches(fence, source, action?.evidence)
      || !hasRemoteTerminationReceipt(lease) || !hasConfirmedSandboxStopAndRetain(lease)) return false;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionFinalization);
    const [settled] = await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null,
      leaseExpiresAt: null, controlDeadlineAt: null, nextAttemptAt: null, recoveryState: "blocked",
      failureCode: "native_continuation_requires_reconciliation", updatedAt: new Date() }).where(and(
        eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId),
        eq(nativeRunFinalizations.issueId, task.id), eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.resultId),
        eq(nativeRunFinalizations.leaseOwner, fence.leaseOwner), eq(nativeRunFinalizations.controllerGeneration, fence.controllerGeneration),
        eq(nativeRunFinalizations.attempt, fence.providerAttempt))).returning({ id: nativeRunFinalizations.runId });
    if (!settled) throw new Error("observed_workspace_preservation_fence_changed");
    await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    await tx.update(issueRecoveryActions).set({ evidence: { ...action!.evidence, [FIELD]: { ...fence, state: "stopped" } }, updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.id, action!.id)));
    await logActivity(tx, { companyId, actorType: "system", actorId: "native-workspace-recovery",
      action: "issue.observed_workspace_stop_verified", entityType: "issue", entityId: task.id, runId,
      details: { recoveryActionId: action!.id, sourceRunId: runId, controllerGeneration: fence.controllerGeneration } });
    return true;
  });
}
