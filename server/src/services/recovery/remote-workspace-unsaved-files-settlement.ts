import { and, eq, inArray, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { OwnerProof } from "../owner-proof.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../remote-workspace-epoch-abandonment.js";
import { notifyTerminalWorkspaceWork } from "../terminal-workspace-work.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export async function settlePreparationOnlyRemoteWorkspaceEpoch(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "run" || !record.runId || !record.companyId) return { settled: false, reason: "owner_not_provable" };
  const runId = record.runId, companyId = record.companyId;
  return db.transaction(async (transaction): Promise<SettleOutcome> => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select({ status: heartbeatRuns.status, executionStage: heartbeatRuns.executionStage,
      runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))).for("update");
    if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) return { settled: false, reason: "owner_run_active" };
    if (run.runtimeModeResolvedAt || run.executionStage !== "preparing") return { settled: false, reason: "writer_reached_runtime" };
    const [finalization] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId))).limit(1);
    if (finalization) return { settled: false, reason: "writer_reached_runtime" };
    const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, record.recordId)));
    const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
    if (!authority?.dirty || authority.writerRunId !== runId || !authority.location) {
      return { settled: false, reason: "unsaved_files_no_longer_held" };
    }
    const [save] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.executionWorkspaceId, record.recordId),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), inArray(workspaceOperations.status, ["running", "pending"]),
      sql`${workspaceOperations.metadata}->>'epoch' = ${String(authority.epoch)}`)).limit(1);
    if (save) return { settled: false, reason: "save_in_flight" };
    await notifyTerminalWorkspaceWork(tx, `workspace:${record.recordId}`);
    try {
      await abandonUnverifiedRemoteWorkspaceEpoch(transaction, {
        companyId, workspaceId: record.recordId, runId, epoch: authority.epoch, snapshotId: authority.snapshotId,
        location: authority.location,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "remote_workspace_authority_changed") {
        return { settled: false, reason: "unsaved_files_no_longer_held" };
      }
      throw error;
    }
    return { settled: true, reason: context.proof.reason };
  });
}
