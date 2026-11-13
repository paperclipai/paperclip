import { and, eq, isNull, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import type { OwnerProof } from "../owner-proof.js";
import { readSaveWork } from "../remote-workspaces.js";
import { abortSnapshotAttemptUploads, notifyRemoteWorkspaceSnapshots, snapshotAttemptKeys } from "../remote-workspace-snapshot-retention.js";
import { getStorageService } from "../../storage/index.js";
import type { StorageService } from "../../storage/types.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

export const ABANDONED_REMOTE_SNAPSHOT_LEDGER_REASON = "abandoned_remote_snapshot_upload";
const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

type Snapshot = typeof executionWorkspaceSnapshots.$inferSelect;

export async function retireEndedRemoteSnapshotLedgerRow(tx: Db, input: {
  companyId: string; snapshotId: string; now: Date; proof: string;
}): Promise<{ retired: true; snapshot: Snapshot; status: "deleted" | "delete_requested" } | { retired: false; reason: string }> {
  const [snapshot] = await tx.select().from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, input.companyId), eq(executionWorkspaceSnapshots.id, input.snapshotId)));
  if (!snapshot || snapshot.status !== "pending") return { retired: false, reason: "ledger_no_longer_pending" };
  if (snapshot.objectKey !== null) return { retired: false, reason: "upload_published" };
  if (!snapshot.sourceRunId) return { retired: false, reason: "owner_run_missing" };
  const [operation] = await tx.select().from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, snapshot.companyId), eq(workspaceOperations.id, snapshot.sourceOperationId))).for("update");
  if (operation) {
    if (operation.phase !== "remote_workspace_snapshot") return { retired: false, reason: "not_a_workspace_save" };
    if (operation.status === "running" || operation.status === "pending") return { retired: false, reason: "save_in_progress" };
    const work = readSaveWork(operation.metadata);
    if (work && (work.unknown || work.activeIds.length)) return { retired: false, reason: "save_work_unsettled" };
  }
  const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, snapshot.companyId), eq(heartbeatRuns.id, snapshot.sourceRunId)));
  if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) return { retired: false, reason: "owner_run_active" };
  const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, snapshot.companyId), eq(executionWorkspaces.id, snapshot.executionWorkspaceId)));
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (authority && authority.epoch === snapshot.epoch && authority.writerRunId === snapshot.sourceRunId) {
    return { retired: false, reason: "writer_epoch_current" };
  }
  const uploads = snapshot.metadata?.uploads;
  const attempted = Array.isArray(uploads) ? uploads.length > 0 : uploads !== undefined && uploads !== null;
  const status = attempted ? "delete_requested" as const : "deleted" as const;
  const provenance = { schema: "paperclip.remote-snapshot-ledger-abandonment.v1", reason: ABANDONED_REMOTE_SNAPSHOT_LEDGER_REASON,
    proof: input.proof, previousStatus: snapshot.status, runId: snapshot.sourceRunId, operationId: snapshot.sourceOperationId,
    epoch: snapshot.epoch, workspaceEpoch: authority?.epoch ?? null, uploadAttempted: attempted, reconciledAt: input.now.toISOString() };
  await notifyRemoteWorkspaceSnapshots(tx, `workspace:${snapshot.executionWorkspaceId}`);
  const [row] = await tx.update(executionWorkspaceSnapshots).set({ status,
    deleteAfter: status === "deleted" ? null : snapshot.deleteAfter, lastError: ABANDONED_REMOTE_SNAPSHOT_LEDGER_REASON,
    metadata: { ...snapshot.metadata, abandonedUpload: provenance }, updatedAt: input.now })
    .where(and(eq(executionWorkspaceSnapshots.id, snapshot.id), eq(executionWorkspaceSnapshots.status, "pending"),
      isNull(executionWorkspaceSnapshots.objectKey),
      sql`${executionWorkspaceSnapshots.metadata} is not distinct from ${snapshot.metadata === null ? null : JSON.stringify(snapshot.metadata)}::jsonb`))
    .returning();
  if (!row) return { retired: false, reason: "ledger_no_longer_pending" };
  return { retired: true, snapshot: row, status };
}

export async function abortRetiredSnapshotUploads(snapshots: Snapshot[], storage?: StorageService) {
  const attempted = snapshots.filter(snapshot => snapshotAttemptKeys(snapshot).length);
  if (!attempted.length) return;
  let service: StorageService;
  try { service = storage ?? getStorageService(); } catch { return; }
  for (const snapshot of attempted) await abortSnapshotAttemptUploads(service, snapshot.companyId, snapshotAttemptKeys(snapshot));
}

export async function settleAbandonedRemoteSnapshotLedger(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }, options: { storage?: StorageService } = {}): Promise<SettleOutcome> {
  if (record.owner.kind !== "run" || !record.companyId) return { settled: false, reason: "owner_not_provable" };
  const companyId = record.companyId;
  let publication: ActivityPublication | undefined;
  let retired: Snapshot | undefined;
  const outcome = await db.transaction(async (transaction): Promise<SettleOutcome> => {
    const tx = transaction as unknown as Db;
    const result = await retireEndedRemoteSnapshotLedgerRow(tx, { companyId, snapshotId: record.recordId,
      now: context.now, proof: context.proof.reason });
    if (!result.retired) {
      return { settled: false, reason: result.reason,
        ...(["upload_published", "not_a_workspace_save"].includes(result.reason) ? { watch: false } : {}) };
    }
    const activity = await persistActivity(tx, {
      companyId, actorType: "system", actorId: "ownership-reconciler",
      action: "workspace_snapshot.reconciled", entityType: "execution_workspace", entityId: result.snapshot.executionWorkspaceId,
      runId: result.snapshot.sourceRunId, details: { snapshotId: result.snapshot.id, status: result.status,
        ...(result.snapshot.metadata?.abandonedUpload as Record<string, unknown>) },
    });
    publication = activity.publication;
    retired = result.snapshot;
    return { settled: true, reason: context.proof.reason };
  });
  if (outcome.settled && publication) publishActivity(publication);
  if (outcome.settled && retired) await abortRetiredSnapshotUploads([retired], options.storage);
  return outcome;
}

export async function retireAbandonedSaveLedgerRows(tx: Db, input: {
  companyId: string; operationId: string; now: Date; proof: string;
}) {
  const rows = await tx.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, input.companyId), eq(executionWorkspaceSnapshots.sourceOperationId, input.operationId),
    eq(executionWorkspaceSnapshots.status, "pending")));
  const retired: Snapshot[] = [];
  for (const row of rows) {
    const result = await retireEndedRemoteSnapshotLedgerRow(tx, { companyId: input.companyId, snapshotId: row.id, now: input.now, proof: input.proof });
    if (result.retired) retired.push(result.snapshot);
  }
  return retired;
}
