import { and, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { executionWorkspaces, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { OwnerProof } from "../owner-proof.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../remote-workspace-epoch-abandonment.js";
import { releaseUnchangedRemoteWorkspaceWriterById } from "../remote-workspaces.js";
import { notifyTerminalWorkspaceWork } from "../terminal-workspace-work.js";
import type { InProgressRecord, SettleOutcome } from "./ownership-registry.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const WORK_STARTED_EVENT_TYPES = ["adapter.invoke", "adapter.progress"];
const WORK_STARTED_EVENT_PREFIXES = ["turn.", "provider.", "native.process_"];

const WRITER_RUN_ID = sql`${executionWorkspaces.metadata}->'remoteWorkspace'->>'writerRunId'`;

export function preparationOnlyWriterCondition(): SQL {
  const workStarted = sql.join([
    sql`event.event_type in (${sql.join(WORK_STARTED_EVENT_TYPES.map(type => sql`${type}`), sql`, `)})`,
    ...WORK_STARTED_EVENT_PREFIXES.map(prefix => sql`event.event_type like ${`${prefix}%`}`),
  ], sql` or `);
  return sql`(${WRITER_RUN_ID} is null or exists (select 1 from heartbeat_runs writer
    where writer.id = (case when ${WRITER_RUN_ID} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${WRITER_RUN_ID})::uuid end) and writer.company_id = ${executionWorkspaces.companyId}
      and writer.execution_stage = 'preparing' and writer.runtime_mode_resolved_at is null
      and writer.process_pid is null and writer.process_group_id is null
      and writer.native_session_id is null and writer.runner_instance_id is null
      and not exists (select 1 from native_run_finalizations finalization
        where finalization.company_id = writer.company_id and finalization.run_id = writer.id)
      and not exists (select 1 from heartbeat_run_events event where event.run_id = writer.id and (${workStarted}))))`;
}

export async function settlePreparationOnlyRemoteWorkspaceEpoch(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "run" || !record.runId || !record.companyId) return { settled: false, reason: "owner_not_provable" };
  const runId = record.runId, companyId = record.companyId;
  return db.transaction(async (transaction): Promise<SettleOutcome> => {
    const tx = transaction as unknown as Db;
    const readRun = () => tx.select({ status: heartbeatRuns.status, executionStage: heartbeatRuns.executionStage,
      runtimeModeResolvedAt: heartbeatRuns.runtimeModeResolvedAt, processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId, nativeSessionId: heartbeatRuns.nativeSessionId,
      runnerInstanceId: heartbeatRuns.runnerInstanceId })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    const [run] = await readRun();
    if (!run || !TERMINAL_RUN_STATUSES.includes(run.status)) return { settled: false, reason: "owner_run_active" };
    if (run.runtimeModeResolvedAt || run.executionStage !== "preparing") return { settled: false, reason: "writer_reached_runtime", watch: false };
    const [finalization] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId))).limit(1);
    if (finalization || run.processPid || run.processGroupId || run.nativeSessionId || run.runnerInstanceId) {
      return { settled: false, reason: "writer_reached_runtime", watch: false };
    }
    const [workStarted] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, runId), or(inArray(heartbeatRunEvents.eventType, WORK_STARTED_EVENT_TYPES),
        ...WORK_STARTED_EVENT_PREFIXES.map(prefix => like(heartbeatRunEvents.eventType, `${prefix}%`))))).limit(1);
    if (workStarted) return { settled: false, reason: "writer_reached_runtime", watch: false };
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
    const [locked] = await readRun().for("update");
    if (!locked || !TERMINAL_RUN_STATUSES.includes(locked.status)) return { settled: false, reason: "owner_run_active" };
    if (locked.runtimeModeResolvedAt || locked.executionStage !== "preparing" || locked.processPid || locked.processGroupId
      || locked.nativeSessionId || locked.runnerInstanceId) return { settled: false, reason: "writer_reached_runtime", watch: false };
    // A preparation that restored the saved version and then did nothing else
    // left exactly that version in its root. When the durable unchanged-baseline
    // proof holds, hand the workspace on at its saved version and keep the root,
    // so the retry reuses the same directory and the saved session still names
    // it. Anything unproven (no baseline from an older release, a provisioning
    // command, a runner command, a process, a kill before the restore published)
    // is abandoned exactly as before.
    if (await releaseUnchangedRemoteWorkspaceWriterById(transaction, { companyId, workspaceId: record.recordId, runId })) {
      return { settled: true, reason: context.proof.reason };
    }
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
