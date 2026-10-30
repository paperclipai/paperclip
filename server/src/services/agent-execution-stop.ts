import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { isCancelledBeforeProviderDispatch } from "./cancelled-pre-dispatch-stop.js";
import { hasLegacyExecutionSettlement } from "./legacy-execution-settlement.js";

export type ExecutionStopBlocker = {
  reason: "environment_lease_retained" | "coordinator_lease_live" | "coordinator_controller_live"
    | "run_not_terminal" | "controller_lease_live" | "remote_termination_unreceipted"
    | "process_alive" | "native_cancellation_unproven" | "legacy_cancellation_unproven";
  runId?: string;
  leaseId?: string;
};

const absent = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
async function inspect(db: Db, agentIds: string[], options: { stopAtFirstBlocker?: boolean } = {}) {
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  const blockers: ExecutionStopBlocker[] = [];
  const block = (reason: ExecutionStopBlocker["reason"], runId?: string | null, leaseId?: string) =>
    blockers.push({ reason, ...(runId ? { runId } : {}), ...(leaseId ? { leaseId } : {}) });
  const halt = () => Boolean(options.stopAtFirstBlocker) && blockers.length > 0;
  for (const lease of leases) {
    if (halt()) return { blockers, abandoned, now };
    if ((!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) ||
      lease.status === "pending_cleanup" || lease.cleanupStatus === "failed") {
      block("environment_lease_retained", lease.heartbeatRunId, lease.id);
    }
  }
  for (const row of abandoned) {
    if (halt()) return { blockers, abandoned, now };
    if (!row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled") block("coordinator_lease_live", row.runId);
  }
  for (const coordinator of abandoned) {
    if (halt()) return { blockers, abandoned, now };
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) {
      block("coordinator_controller_live", coordinator.runId);
    }
  }
  for (const run of runs) {
    if (halt()) return { blockers, abandoned, now };
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) {
      block("run_not_terminal", run.id);
      continue;
    }
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) {
      block("controller_lease_live", run.id);
      continue;
    }
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) block("remote_termination_unreceipted", run.id);
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
    if (processAlive || groupAlive) {
      block("process_alive", run.id);
      continue;
    }
    if (run.status !== "cancelled" || !run.startedAt) continue;
    const coordinator = coordinators.find(row => row.runId === run.id);
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinator)) block("native_cancellation_unproven", run.id);
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(hasLegacyExecutionSettlement(run) && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinator) &&
        !await isCancelledBeforeProviderDispatch(db, run, coordinator)) block("legacy_cancellation_unproven", run.id);
  }
  return { blockers, abandoned, now };
}

export async function listAgentExecutionStopBlockers(db: Db, agentIds: string[]): Promise<ExecutionStopBlocker[]> {
  if (!agentIds.length) return [];
  return (await inspect(db, agentIds)).blockers;
}

export function describeExecutionStopBlockers(blockers: ExecutionStopBlocker[]): string {
  const reasons = new Map<string, string[]>();
  for (const blocker of blockers) {
    const subjects = reasons.get(blocker.reason) ?? [];
    if (blocker.runId ?? blocker.leaseId) subjects.push((blocker.runId ?? blocker.leaseId)!);
    reasons.set(blocker.reason, subjects);
  }
  const summary = [...reasons].map(([reason, subjects]) => {
    const shown = subjects.slice(0, 5).join(", ");
    const extra = subjects.length > 5 ? `, +${subjects.length - 5} more` : "";
    return subjects.length ? `${reason} (${shown}${extra})` : reason;
  }).join("; ");
  return `Waiting for ${blockers.length} execution record(s) to prove they stopped: ${summary}`;
}

export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const { blockers, abandoned, now } = await inspect(db, agentIds, { stopAtFirstBlocker: true });
  if (blockers.length) return false;
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        eq(nativeRunFinalizations.leaseExpiresAt, coordinator.leaseExpiresAt!),
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
