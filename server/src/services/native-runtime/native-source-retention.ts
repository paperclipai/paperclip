import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { persistActivity } from "../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { createSystemRecovery, readSystemRecovery, SystemRecoveryFailure, type SystemRecoveryState } from "../system-recovery-state.js";
import { updateSystemRecovery } from "../system-recovery.js";
import { readTaskRetryIntent, taskRetryMutationAllowed } from "../task-retry.js";
import { inspectWorkspaceRecoverySource, type WorkspaceRecoverySourceIdentity } from "../workspace-recovery-source.js";
import { hasVerifiedWorkspaceRepair } from "../workspace-recovery-receipt.js";
import { verifiedWorkspaceSnapshotReceipt } from "../workspace-recovery-snapshot.js";
import type { NativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

export function canAdoptNativeSourceRetention(state: SystemRecoveryState) {
  return state.state === "exhausted" && state.phase === "verify_execution" && state.attempts === 1
    && state.retriesUsed === 0 && state.failure?.code === "source_binding_invalid"
    && (!state.failure.sourceVerification || state.failure.sourceVerification.reason === "lease_policy_not_retained")
    && state.preservationOperationIds.length === 0 && !state.freshAttemptRunId;
}

export async function retainNativeRecoverySource(db: Db, input: WorkspaceRecoverySourceIdentity,
  previous: SystemRecoveryState, ownership: NativeWorkspaceFinalizationOwnership): Promise<SystemRecoveryState | null> {
  if (!canAdoptNativeSourceRetention(previous)) return null;
  await ownership.assertHeld();
  try {
    return await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
        eq(nativeRunFinalizations.issueId, input.issueId))).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).for("update");
      const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
        eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
      const current = readSystemRecovery(action?.evidence);
      if (!issue || !run || !action || !current || current.generationId !== previous.generationId || current.revision !== previous.revision
        || action.evidence.nativeSourceRetention || action.status === "cancelled" || action.evidence.executionReconciliation
        || !coordinator || coordinator.phase !== "terminal_failure" || coordinator.leaseOwner
        || coordinator.failureDetail?.successorRunId || issue.assigneeAgentId !== run.agentId || issue.executionRunId || issue.checkoutRunId
        || ["done", "cancelled"].includes(issue.status)) return null;
      const [latest] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId), or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
      )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
      if (latest?.id !== run.id) return null;
      const [request] = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.runId} is null`,
        sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
        sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${input.runId}`,
      )).limit(1).for("update");
      const intent = readTaskRetryIntent(request?.payload);
      if (!request || !intent || intent.generationId !== request.id || intent.actorId !== request.requestedByActorId
        || intent.chatActionId || intent.boardMessageOrigin || intent.canonicalIntentId
        || !await taskRetryMutationAllowed(tx as unknown as Db, { companyId: input.companyId,
          issueId: input.issueId, actorId: intent.actorId, actorSource: intent.actorSource })) return null;
      const inspected = await inspectWorkspaceRecoverySource(tx as unknown as Db, input, { maximumSources: 1, prepareNativeRetention: true });
      const source = inspected.sources[0];
      if (!source?.reference || source.reference.state !== "prepared" || source.reference.resourceDisposition !== "keep_running"
        || source.lease.leasePolicy !== "reuse_by_environment" || !["released", "retained"].includes(source.lease.status)) return null;
      const marker = { schema: "paperclip.native-source-retention.v1", sourceRunId: run.id, actionId: action.id,
        requestId: request.id, leaseId: source.lease.id, providerLeaseId: source.lease.providerLeaseId,
        descriptorSha256: source.reference.descriptorSha256, baselineSha256: source.reference.baselineSha256,
        workspaceId: source.reference.workspaceId, originalLeasePolicy: "reuse_by_environment" };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
      const [retained] = await tx.update(environmentLeases).set({ leasePolicy: "retain_on_failure", updatedAt: new Date(),
        metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ nativeSourceRetention: marker })}::jsonb`,
      }).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, source.lease.id),
        eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.leasePolicy, "reuse_by_environment"),
        eq(environmentLeases.status, source.lease.status),
        sql`${environmentLeases.metadata} is not distinct from ${JSON.stringify(source.lease.metadata)}::jsonb`,
      )).returning({ id: environmentLeases.id });
      if (!retained) return null;
      const next = { ...createSystemRecovery(run.id), intentId: request.id, revision: previous.revision + 1,
        providerCooldownAt: previous.providerCooldownAt, nextAttemptAt: previous.providerCooldownAt };
      if (!await updateSystemRecovery(tx as unknown as Db, input, previous, next)) throw new Error("workspace_recovery_generation_changed");
      await tx.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} ||
        ${JSON.stringify({ nativeSourceRetention: { ...marker, previousGeneration: previous } })}::jsonb`,
      }).where(eq(issueRecoveryActions.id, action.id));
      await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "native-source-retention",
        action: "issue.native_workspace_source_retained", entityType: "issue", entityId: input.issueId, runId: run.id,
        details: { recoveryActionId: action.id, requestId: request.id, leaseId: source.lease.id,
          previousGeneration: previous, nextGenerationId: next.generationId } });
      return next;
    });
  } catch (error) {
    if (error instanceof SystemRecoveryFailure) return null;
    throw error;
  }
}

export async function settleRecoveredNativeSourceRetention(db: Db, input: WorkspaceRecoverySourceIdentity, operationIds: string[]) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run) return false;
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (!reference || reference.resourceDisposition !== "keep_running") return false;
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.heartbeatRunId, run.id)));
  const marker = lease?.metadata?.nativeSourceRetention as Record<string, unknown> | undefined;
  if (!lease || marker?.schema !== "paperclip.native-source-retention.v1" || marker.sourceRunId !== run.id
    || marker.actionId !== input.actionId || marker.leaseId !== lease.id || marker.providerLeaseId !== reference.providerLeaseId
    || lease.providerLeaseId !== reference.providerLeaseId || lease.metadata?.remoteCwd !== reference.remoteCwd
    || marker.baselineSha256 !== reference.baselineSha256 || marker.workspaceId !== reference.workspaceId
    || marker.originalLeasePolicy !== "reuse_by_environment"
    || !hasRemoteTerminationReceipt(lease) || lease.metadata?.pendingCleanupInFlight === true
    || (lease.metadata?.remoteExecutionTermination as { state?: string })?.state !== "stopped") return false;
  const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
  )).limit(1);
  if (other) return false;
  if (reference.state === "prepared") {
    const operation = await verifiedWorkspaceSnapshotReceipt(db, { ...input, operationIds,
      leaseId: lease.id, providerLeaseId: reference.providerLeaseId });
    if (!operation) return false;
    const [retained] = await db.update(environmentLeases).set({ updatedAt: new Date(),
      metadata: { ...lease.metadata, nativeSourceRetention: { ...marker, settlement: "snapshot_retained", snapshotOperationId: operation.id } },
    }).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, lease.id),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.leasePolicy, "retain_on_failure"),
      eq(environmentLeases.status, "released"), sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    )).returning({ id: environmentLeases.id });
    if (!retained) return false;
    const [settled] = await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{nativeSourceRetention}', (${issueRecoveryActions.evidence}->'nativeSourceRetention') ||
      ${JSON.stringify({ settlement: "snapshot_retained", snapshotOperationId: operation.id })}::jsonb)` }).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
    )).returning({ id: issueRecoveryActions.id });
    return Boolean(settled);
  }
  if (!await hasVerifiedWorkspaceRepair(db, run)) return false;
  const restored = await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment", updatedAt: new Date() }).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, lease.id),
    eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.leasePolicy, "retain_on_failure"),
    eq(environmentLeases.status, "released"), sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
  )).returning({ id: environmentLeases.id });
  return restored.length === 1;
}
