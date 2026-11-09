import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import type { OwnerProof } from "../owner-proof.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { isRemoteWorkspaceSaveInvocationLive, readSaveWork } from "../remote-workspaces.js";
import { notifyTerminalWorkspaceWork } from "../terminal-workspace-work.js";
import { RETAINED_SOURCE_FALLBACK_CHECK_KEY } from "../workspace-recovery-fallback-discovery.js";
import { LOCAL_WORKSPACE_COMMAND_PHASES, isOwnerStampedWorkspaceOperationLive } from "../workspace-operations.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

export const ABANDONED_WORKSPACE_FINALIZE_REASON = "abandoned_workspace_finalization";
export const ABANDONED_WORKSPACE_COMMAND_REASON = "abandoned_workspace_command";
const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

/**
 * Settle of the `native_workspace_finalize_attempt` ownership kind (plan Phase 2).
 *
 * A restart between a finalize attempt's start and its copyback, or between
 * copyback and the row's terminal write, leaves the attempt `running` for good:
 * the process that drove it is gone, and the run finishes through a later
 * attempt or recovery. The crash-point suite found both windows.
 *
 * The shared reconciler calls this only with a `gone` proof: the stamped
 * `finalizeOwner` process is proven gone, or, for a row written before the
 * stamp, its run is terminal. Settle marks only that attempt `failed` with its
 * provenance. It never changes the run or its outcome, never touches an attempt
 * this process is still driving, and leaves independent obligations alone
 * (an uncertain export or a save-work record), like the RC-64 supersession.
 */
export const settleAbandonedWorkspaceFinalizeAttempt = abandonedWorkspaceOperationSettle({
  phases: ["workspace_finalize"], statuses: ["running", "pending"], ownerKey: "finalizeOwner",
  provenanceKey: "abandonedFinalization", schema: "paperclip.workspace-finalize-abandonment.v1",
  reason: ABANDONED_WORKSPACE_FINALIZE_REASON,
  message: "Workspace finalization was interrupted before it finished; the process that ran it is gone.\n",
});

export const settleAbandonedWorkspaceCommandOperation = abandonedWorkspaceOperationSettle({
  phases: LOCAL_WORKSPACE_COMMAND_PHASES, statuses: ["running"], ownerKey: "commandOwner",
  provenanceKey: "abandonedCommand", schema: "paperclip.workspace-command-abandonment.v1",
  reason: ABANDONED_WORKSPACE_COMMAND_REASON,
  message: "The workspace command was interrupted before it finished; the process that ran it is gone.\n",
});

function abandonedWorkspaceOperationSettle(spec: { phases: readonly string[]; statuses: string[]; ownerKey: string;
  provenanceKey: string; schema: string; reason: string; message: string }) {
  return async (db: Db, record: InProgressRecord, context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> => {
    if (isOwnerStampedWorkspaceOperationLive(record.recordId)) return { settled: false, reason: "attempt_live_in_this_process" };
    let publication: ActivityPublication | undefined;
    const outcome = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [operation] = await tx.select().from(workspaceOperations)
        .where(and(eq(workspaceOperations.id, record.recordId), inArray(workspaceOperations.phase, [...spec.phases]),
          inArray(workspaceOperations.status, spec.statuses)))
        .for("update");
      if (!operation) return { settled: false, reason: "attempt_no_longer_in_progress" };
      const metadata = operation.metadata ?? {};
      if (metadata.uncertain === true || metadata.uncertain === "true" || metadata.saveWork != null
        || metadata.runtimeControlOwner != null) {
        return { settled: false, reason: "independent_obligation" };
      }
      // A run-owned (pre-stamp) attempt needs its run to be terminal now.
      if (record.owner.kind === "run") {
        if (!operation.heartbeatRunId) return { settled: false, reason: "owner_run_missing" };
        const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, operation.heartbeatRunId), inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES)));
        if (!run) return { settled: false, reason: "owner_run_active" };
      } else if (record.owner.kind === "process") {
        // The proof judged this exact owner; a re-stamped attempt is another owner.
        const owner = metadata[spec.ownerKey] as Record<string, unknown> | undefined;
        if (owner?.bootId !== record.owner.stamp.bootId || owner?.pid !== record.owner.stamp.pid) {
          return { settled: false, reason: "owner_changed_since_proof" };
        }
      } else {
        return { settled: false, reason: "owner_not_provable" };
      }
      const now = context.now;
      const provenance = {
        schema: spec.schema,
        reason: spec.reason,
        proof: context.proof.reason,
        previousStatus: operation.status,
        runId: operation.heartbeatRunId,
        reconciledAt: now.toISOString(),
      };
      // Register the wake intent before the write so drain and sleep checks see it.
      const workKey = operation.executionWorkspaceId ? `workspace:${operation.executionWorkspaceId}`
        : operation.issueId ? `issue:${operation.issueId}` : null;
      if (workKey) await notifyTerminalWorkspaceWork(tx, workKey);
      const [row] = await tx.update(workspaceOperations).set({
        status: "failed", finishedAt: now, updatedAt: now,
        stderrExcerpt: `${operation.stderrExcerpt ?? ""}${spec.message}`.slice(-4096),
        metadata: { ...metadata, [spec.provenanceKey]: provenance },
      }).where(and(eq(workspaceOperations.id, operation.id), eq(workspaceOperations.status, operation.status)))
        .returning({ id: workspaceOperations.id });
      if (!row) return { settled: false, reason: "attempt_no_longer_in_progress" };
      const activity = await persistActivity(tx, {
        companyId: operation.companyId, actorType: "system", actorId: "ownership-reconciler",
        action: "workspace_operation.reconciled", entityType: "workspace_operation", entityId: operation.id,
        runId: operation.heartbeatRunId, issueId: operation.issueId, details: provenance,
      });
      publication = activity.publication;
      return { settled: true, reason: context.proof.reason };
    });
    if (outcome.settled && publication) publishActivity(publication);
    return outcome;
  };
}

export const ABANDONED_REMOTE_SNAPSHOT_SAVE_REASON = "abandoned_remote_snapshot_save";

export async function settleAbandonedRemoteSnapshotSave(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  let publication: ActivityPublication | undefined;
  const outcome = await db.transaction(async (transaction): Promise<SettleOutcome> => {
    const tx = transaction as unknown as Db;
    const [operation] = await tx.select().from(workspaceOperations)
      .where(and(eq(workspaceOperations.id, record.recordId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
        inArray(workspaceOperations.status, ["running", "pending"])))
      .for("update");
    if (!operation) return { settled: false, reason: "attempt_no_longer_in_progress" };
    const metadata = operation.metadata ?? {};
    const work = readSaveWork(metadata);
    if (!work || work.unknown || (!work.activeIds.length && !work.quiescedAt)) return { settled: false, reason: "save_work_unsettled" };
    const owners = work.owners ?? {};
    if (work.activeIds.some(isRemoteWorkspaceSaveInvocationLive)) return { settled: false, reason: "attempt_live_in_this_process" };
    if (record.owner.kind === "process") {
      const { bootId, pid } = record.owner.stamp;
      if (!work.activeIds.length || work.activeIds.some(id => owners[id]?.bootId !== bootId || owners[id]?.pid !== pid)) {
        return { settled: false, reason: "owner_changed_since_proof" };
      }
    } else if (record.owner.kind === "run") {
      if (work.activeIds.some(id => owners[id] !== undefined
        && (owners[id]!.bootId !== currentControllerBootId() || owners[id]!.pid !== process.pid))) {
        return { settled: false, reason: "owner_changed_since_proof" };
      }
      const [run] = operation.heartbeatRunId ? await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, operation.heartbeatRunId), inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES))) : [];
      if (!run) return { settled: false, reason: "owner_run_active" };
    } else {
      return { settled: false, reason: "owner_not_provable" };
    }
    const now = context.now;
    const provenance = {
      schema: "paperclip.remote-snapshot-save-abandonment.v1",
      reason: ABANDONED_REMOTE_SNAPSHOT_SAVE_REASON,
      proof: context.proof.reason,
      previousStatus: operation.status,
      runId: operation.heartbeatRunId,
      quiescedAt: work.quiescedAt,
      abandonedInvocationIds: work.activeIds,
      reconciledAt: now.toISOString(),
    };
    const workKey = operation.executionWorkspaceId ? `workspace:${operation.executionWorkspaceId}`
      : operation.issueId ? `issue:${operation.issueId}` : null;
    if (workKey) await notifyTerminalWorkspaceWork(tx, workKey);
    const [row] = await tx.update(workspaceOperations).set({
      status: "failed", exitCode: 1, finishedAt: now, updatedAt: now,
      stderrExcerpt: `${operation.stderrExcerpt ?? ""}The workspace save stopped without finishing; the process that ran it is gone.\n`.slice(-4096),
      metadata: { ...metadata, abandonedSave: provenance,
        saveWork: { ...work, activeIds: [], owners: {}, quiescedAt: work.quiescedAt ?? now.toISOString() },
        lastFailure: { code: "remote_workspace_save_abandoned", at: now.toISOString() } },
    }).where(and(eq(workspaceOperations.id, operation.id), eq(workspaceOperations.status, operation.status)))
      .returning({ id: workspaceOperations.id });
    if (!row) return { settled: false, reason: "attempt_no_longer_in_progress" };
    if (operation.executionWorkspaceId) {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
      await tx.update(issueRecoveryActions).set({
        evidence: sql`${issueRecoveryActions.evidence} - ${RETAINED_SOURCE_FALLBACK_CHECK_KEY}::text`,
      }).where(and(eq(issueRecoveryActions.companyId, operation.companyId), inArray(issueRecoveryActions.status, ["active", "escalated"]),
        sql`${issueRecoveryActions.evidence}->${RETAINED_SOURCE_FALLBACK_CHECK_KEY}->>'reason' = 'workspace_operation_running'`,
        sql`exists (select 1 from heartbeat_runs source where source.company_id = ${issueRecoveryActions.companyId}
          and source.id::text = ${issueRecoveryActions.evidence}->>'runId'
          and source.runner_profile_json#>>'{remoteWorkspace,workspaceId}' = ${operation.executionWorkspaceId})`));
    }
    const activity = await persistActivity(tx, {
      companyId: operation.companyId, actorType: "system", actorId: "ownership-reconciler",
      action: "workspace_operation.reconciled", entityType: "workspace_operation", entityId: operation.id,
      runId: operation.heartbeatRunId, issueId: operation.issueId, details: provenance,
    });
    publication = activity.publication;
    return { settled: true, reason: context.proof.reason };
  });
  if (outcome.settled && publication) publishActivity(publication);
  return outcome;
}
