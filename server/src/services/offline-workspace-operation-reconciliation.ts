import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import { offlineWorkspaceMigrationBlockers } from "./remote-workspace-migration-tree.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";

type Candidate = typeof workspaceOperations.$inferSelect;
type Held = { operationId: string; reason: string };
const unresolved = () => inArray(workspaceOperations.status, ["running", "pending"]);
const localMigrationSource = () => and(isNotNull(executionWorkspaces.cwd),
  inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]),
  sql`coalesce(${executionWorkspaces.metadata}->'remoteWorkspace'->>'schema', '') <> 'paperclip.remote-workspace.v1'`);

async function assertOffline(db: Db, writersStopped: boolean) {
  // Only the Cloud maintenance caller can establish that all old deployments
  // stopped. The environment switch alone is never that acknowledgement.
  if (!writersStopped) throw new Error("offline_maintenance_required");
  const blockers = await offlineWorkspaceMigrationBlockers(db);
  if (blockers.length) throw new Error(blockers[0]);
}

function databaseCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: unknown } | null;
  return value?.code ?? (value?.cause ? databaseCode(value.cause) : undefined);
}

async function reconcileAttempt(db: Db, candidate: Candidate, input: { writersStopped: boolean; signal: AbortSignal }) {
  const held = (reason: string): Held => ({ operationId: candidate.id, reason });
  const { heartbeatRunId: runId, issueId, executionWorkspaceId: workspaceId } = candidate;
  if (candidate.phase !== "workspace_finalize" || !runId || !issueId || !workspaceId)
    return held("superseding_finalization_receipt_missing");
  try {
    return await db.transaction(async tx => {
      const database = tx as unknown as Db;
      input.signal.throwIfAborted();
      await assertOffline(database, input.writersStopped);
      if (!await tryLockNativeWorkspaceFinalization(database, { companyId: candidate.companyId, runId }))
        return held("finalization_owner_busy");
      // Follow the finalizer's coordinator-before-run order. NOWAIT keeps an
      // unexpected surviving writer visible instead of waiting or stealing it.
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.issueId, issueId),
        eq(nativeRunFinalizations.runId, runId),
      )).for("update", { noWait: true });
      const [run] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.nativeIssueId, issueId),
      )).for("update", { noWait: true });
      if (!run || run.runtimeMode !== "native" || run.status !== "succeeded"
        || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())
        || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null || !coordinator || coordinator.phase !== "committed"
        || !coordinator.resultId || coordinator.leaseOwner !== null || coordinator.leaseExpiresAt !== null || coordinator.nextAttemptAt !== null)
        return held("committed_finalization_proof_missing");
      const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
      if (!reference || reference.state !== "finalized" || !reference.finalHostSha256 || reference.workspaceId !== workspaceId)
        return held("finalized_workspace_proof_missing");
      const [workspace] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
        eq(executionWorkspaces.companyId, candidate.companyId), eq(executionWorkspaces.id, workspaceId), localMigrationSource(),
      )).for("share", { noWait: true });
      if (!workspace) return held("workspace_authority_changed");
      const [result] = await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
        eq(nativeRunResults.companyId, candidate.companyId), eq(nativeRunResults.issueId, issueId),
        eq(nativeRunResults.runId, runId), eq(nativeRunResults.id, coordinator.resultId),
        eq(nativeRunResults.completionContractId, run.completionContractId!), eq(nativeRunResults.schemaStatus, "accepted"),
      )).for("share", { noWait: true });
      if (!result) return held("accepted_result_proof_missing");
      const [current] = await tx.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.id, candidate.id), eq(workspaceOperations.companyId, candidate.companyId),
        eq(workspaceOperations.executionWorkspaceId, workspaceId), eq(workspaceOperations.issueId, issueId),
        eq(workspaceOperations.heartbeatRunId, runId), eq(workspaceOperations.phase, "workspace_finalize"), unresolved(),
      )).for("update", { noWait: true });
      if (!current) return held("attempt_changed");
      // These fields represent independent obligations. A successful later
      // export does not authorize dropping them or rewriting earlier history.
      if (current.metadata?.uncertain === true || current.metadata?.uncertain === "true"
        || current.metadata?.saveWork != null || current.metadata?.offlineReconciliation != null)
        return held("independent_operation_obligation");
      const [receipt] = await tx.select().from(workspaceOperations).where(and(
        eq(workspaceOperations.companyId, candidate.companyId), eq(workspaceOperations.executionWorkspaceId, workspaceId),
        eq(workspaceOperations.issueId, issueId), eq(workspaceOperations.heartbeatRunId, runId),
        eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"),
        isNotNull(workspaceOperations.finishedAt),
        // Keep PostgreSQL timestamp precision when proving which attempt is later.
        sql`${workspaceOperations.createdAt} > (select created_at from workspace_operations where id = ${current.id}::uuid)`,
      )).orderBy(desc(workspaceOperations.createdAt), desc(workspaceOperations.id)).limit(1).for("share", { noWait: true });
      if (!receipt || receipt.metadata?.uncertain === true || receipt.metadata?.uncertain === "true")
        return held("superseding_finalization_receipt_missing");
      input.signal.throwIfAborted();
      await assertOffline(database, input.writersStopped);
      const now = new Date();
      const provenance = { schema: "paperclip.offline-workspace-operation-reconciliation.v1",
        reason: "superseded_workspace_finalization", reconciledAt: now.toISOString(), previousStatus: current.status,
        supersedingOperationId: receipt.id, runId, resultId: result.id,
        descriptorSha256: reference.descriptorSha256, finalHostSha256: reference.finalHostSha256 };
      await tx.update(workspaceOperations).set({ status: "failed", finishedAt: now, updatedAt: now,
        metadata: { ...current.metadata, offlineReconciliation: provenance } }).where(and(
        eq(workspaceOperations.id, current.id), eq(workspaceOperations.companyId, current.companyId), unresolved(),
      ));
      // No live publication is needed in the stopped maintenance process. The
      // audit and the failed attempt commit (or roll back) together.
      await persistActivity(database, { companyId: current.companyId, actorType: "system", actorId: "ephemeral-migration",
        action: "workspace_operation.reconciled", entityType: "workspace_operation", entityId: current.id,
        runId, issueId, details: provenance });
      return null;
    });
  } catch (error) {
    if (databaseCode(error) === "55P03") return held("execution_rows_busy");
    throw error;
  }
}

/** Reconcile receipts only after Cloud has stopped all old application and
 * worker deployments. This never executes workspace work, declares success,
 * clears execution authority, or retires a recovery/source obligation. */
export async function reconcileOfflineWorkspaceOperations(db: Db, input: {
  writersStopped: boolean; signal: AbortSignal; companyId?: string;
}) {
  await assertOffline(db, input.writersStopped);
  let after: string | undefined, inspected = 0, reconciled = 0;
  const held: Held[] = [];
  for (;;) {
    input.signal.throwIfAborted();
    const rows = await db.select({ operation: workspaceOperations }).from(workspaceOperations).innerJoin(executionWorkspaces, and(
      eq(executionWorkspaces.companyId, workspaceOperations.companyId), eq(executionWorkspaces.id, workspaceOperations.executionWorkspaceId),
    )).where(and(unresolved(), localMigrationSource(),
      input.companyId ? eq(workspaceOperations.companyId, input.companyId) : undefined,
      after ? gt(workspaceOperations.id, after) : undefined,
    )).orderBy(asc(workspaceOperations.id)).limit(100);
    if (!rows.length) return { inspected, reconciled, held };
    for (const { operation } of rows) {
      input.signal.throwIfAborted();
      const outcome = await reconcileAttempt(db, operation, input);
      inspected++;
      if (outcome) held.push(outcome); else reconciled++;
    }
    after = rows.at(-1)!.operation.id;
  }
}
