import { execFile } from "node:child_process";
import os from "node:os";
import { readProcessStartedAt } from "./hot-restart.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

/** Written by the legacy executor when it settles a cancelled run without
 * ever entering the adapter, so no process was spawned to prove against. */
export const LEGACY_ADAPTER_NOT_ENTERED_RECEIPT = "legacyAdapterNotEnteredAt";

// No local process outlives a host reboot. The margin absorbs clock skew
// between the wall clock and the uptime reading.
const HOST_BOOT_MARGIN_MS = 60_000;

function beforeHostBoot(at: Date | null) {
  return Boolean(at && at.getTime() < Date.now() - os.uptime() * 1000 - HOST_BOOT_MARGIN_MS);
}

/** Start times of a process group's current members, or null if any is unreadable. */
async function processGroupMemberStartTimes(processGroupId: number): Promise<Date[] | null> {
  if (process.platform === "win32") return null;
  const stdout = await new Promise<string>((resolve, reject) => execFile("ps", ["-A", "-o", "pid=,pgid="],
    { encoding: "utf8", timeout: 1_500, windowsHide: true },
    (error, output) => error ? reject(error) : resolve(output))).catch(() => null);
  if (stdout === null) return null;
  const members = stdout.split("\n").map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pgid === processGroupId && Number.isInteger(pid) && pid > 0).map(([pid]) => pid);
  const startedAt: Array<string | null> = await Promise.all(members.map(pid => readProcessStartedAt(pid).catch(() => null)));
  return startedAt.every(Boolean) ? startedAt.map(value => new Date(value!)) : null;
}

/** A dead leader's group ID can be recycled. Every member of the run's own
 * group was alive when the run finished, so a group made only of later
 * processes belongs to someone else. */
async function processGroupReusedAfter(processGroupId: number, finishedAt: Date) {
  const members = await processGroupMemberStartTimes(processGroupId);
  return Boolean(members && members.every(startedAt => startedAt.getTime() > finishedAt.getTime()));
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  if (!agentIds.length) return true;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return false;
      continue;
    }
    // A process identity recorded before this host booted cannot be live;
    // whatever holds that PID or group now is unrelated.
    const startedBeforeBoot = beforeHostBoot(run.processStartedAt ?? run.finishedAt);
    if (!startedBeforeBoot) {
      let processAlive = Boolean(run.processPid && !absent(run.processPid));
      let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
      if (processAlive && run.processStartedAt) {
        const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
        if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
          processAlive = false;
          if (run.processGroupId === run.processPid) groupAlive = false;
        }
      }
      if (groupAlive && !processAlive && run.finishedAt &&
          await processGroupReusedAfter(run.processGroupId!, run.finishedAt)) groupAlive = false;
      if (processAlive || groupAlive) return false;
    }
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && typeof run.resultJson?.[LEGACY_ADAPTER_NOT_ENTERED_RECEIPT] === "string") &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        // Conversation adapters run local CLI processes, which a reboot ends.
        !(startedBeforeBoot && await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
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
    if (!cleared) return false;
  }
  return true;
}
