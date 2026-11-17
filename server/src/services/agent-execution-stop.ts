import { readProcessStartedAt } from "./hot-restart.js";
import { readLeaseReleaseDeferral } from "./environment-lease-release-deferral.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await agentExecutionStopBlocker(db, agentIds)) === null;
}

export async function agentExecutionStopBlocker(db: Db, agentIds: string[]): Promise<string | null> {
  if (!agentIds.length) return null;
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const nonLocalLeaseRunIds = db.select({ id: environmentLeases.heartbeatRunId }).from(environmentLeases)
    .where(and(inArray(environmentLeases.heartbeatRunId, runIds), isNotNull(environmentLeases.provider),
      notInArray(environmentLeases.provider, ["", "local"])));
  const ownedFinalizationRunIds = db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .where(and(inArray(nativeRunFinalizations.runId, runIds), isNotNull(nativeRunFinalizations.leaseOwner)));
  const runs = await db.select({
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    startedAt: heartbeatRuns.startedAt,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt,
    runtimeMode: heartbeatRuns.runtimeMode,
    executionCancellationState: sql<string | null>`${heartbeatRuns.resultJson}->'executionCancellation'->>'state'`,
  }).from(heartbeatRuns).where(and(inArray(heartbeatRuns.agentId, agentIds), or(
    notInArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES),
    gt(heartbeatRuns.controllerLeaseExpiresAt, new Date()),
    isNotNull(heartbeatRuns.processPid),
    isNotNull(heartbeatRuns.processGroupId),
    and(eq(heartbeatRuns.status, "cancelled"), isNotNull(heartbeatRuns.startedAt)),
    inArray(heartbeatRuns.id, nonLocalLeaseRunIds),
    inArray(heartbeatRuns.id, ownedFinalizationRunIds),
  )));
  const loadRun = async (id: string) => {
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    if (!row) throw new Error(`Heartbeat run ${id} disappeared during execution stop assessment`);
    return row;
  };
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  const deferred = leases.find(lease => lease.status === "active" && readLeaseReleaseDeferral(lease.metadata));
  if (deferred) return `environment_lease_release_deferred:${readLeaseReleaseDeferral(deferred.metadata)!.reason}`;
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "environment_lease_unreleased";
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return "native_finalization_owned";
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return "native_controller_alive";
  }
  for (const run of runs) {
    if (!TERMINAL_RUN_STATUSES.includes(run.status)) return "run_not_terminal";
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return "run_controller_lease_held";
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return "remote_stop_unconfirmed";
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return "run_process_alive";
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.processPid || run.processGroupId || !["native", "legacy"].includes(run.runtimeMode)) continue;
    if (run.runtimeMode === "legacy" && run.executionCancellationState === "acknowledged") continue;
    const full = await loadRun(run.id);
    const coordinator = coordinators.find(row => row.runId === run.id);
    if (full.runtimeMode === "native" &&
        !await hasNativeLocalProcessStop(db, full.companyId, full.id) &&
        !await isCancelledNativeStartup(db, full, coordinator)) return "native_stop_unproven";
    if (full.runtimeMode === "legacy" &&
        (full.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(full.executionStage === "settled" && !await runUsedConversationAdapter(db, full)) &&
        !await isCancelledNativeStartup(db, full, coordinator)) return "legacy_stop_unproven";
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return "native_finalization_release_raced";
  }
  return null;
}
