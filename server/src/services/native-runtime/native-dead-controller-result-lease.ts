import { currentControllerProcess } from "../controller-process-identity.js";
import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, notLike, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import { currentNativeControllerIdentity, evaluateNativeControllerTakeover, recordLegacyHostFallbackProof } from "./native-restart-recovery.js";

type TakeoverProbe = Pick<Parameters<typeof evaluateNativeControllerTakeover>[0], "isProcessAlive" | "readProcessStartedAt">;

/**
 * A hard kill (SIGKILL, OOM, host crash) after `run.result` is accepted leaves
 * the result leased to a controller of an earlier boot. A graceful drain expires
 * that lease itself; a killed process cannot. Without this release, result
 * finalization waits the full lease (up to 20 minutes) and the run stays
 * `running` with its follow-up work held.
 *
 * Ownership is proved by controller identity, never by lease age: the
 * executor lease belongs to a different boot and its recorded controller
 * process has exited (or its PID now names a different process). A live or
 * unidentifiable owner, and any lease not written with that identity, keeps
 * its lease. The process must be in this controller's known kernel/PID
 * namespace before a local PID probe can prove anything about it. Legacy,
 * foreign and unknown namespaces keep their original expiry. Remote
 * workspaces keep their fenced lease semantics.
 */
export async function releaseDeadControllerResultLeases(db: Db, input: {
  now: Date;
  runIds?: string[];
  liveRunExecutions?: { has(runId: string): boolean };
} & TakeoverProbe): Promise<Array<{ runId: string; reason: string }>> {
  const controller = await currentNativeControllerIdentity();
  const { hostHash } = await currentControllerProcess();
  if (hostHash === "unknown") return [];
  const candidates = await db.select({
    runId: nativeRunFinalizations.runId,
    companyId: nativeRunFinalizations.companyId,
    issueId: nativeRunFinalizations.issueId,
    agentId: heartbeatRuns.agentId,
    leaseOwner: nativeRunFinalizations.leaseOwner,
    leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    controllerBootId: nativeRunFinalizations.controllerBootId,
    controllerPid: nativeRunFinalizations.controllerPid,
    controllerHostHash: nativeRunFinalizations.controllerHostHash,
    controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt,
  }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId),
      eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      eq(heartbeatRuns.status, "running"),
      isNotNull(nativeRunFinalizations.resultId),
      notInArray(nativeRunFinalizations.phase, ["committed", "terminal_failure"]),
      isNotNull(nativeRunFinalizations.leaseOwner),
      // Only an executor's lease is written with the controller identity probed
      // below, including an executor that adopted a resume claim (a pending
      // resume claim never holds an accepted result). Finalizer and cleanup
      // claims keep an earlier executor's identity, so a dead earlier executor
      // proves nothing about them. Their own leases are short and expire.
      notLike(nativeRunFinalizations.leaseOwner, "native-finalizer:%"),
      notLike(nativeRunFinalizations.leaseOwner, "native-cleanup:%"),
      gt(nativeRunFinalizations.leaseExpiresAt, input.now),
      isNotNull(nativeRunFinalizations.controllerBootId),
      ne(nativeRunFinalizations.controllerBootId, controller.bootId),
      eq(nativeRunFinalizations.controllerHostHash, hostHash),
      // Remote copyback is fenced by its own controller lease.
      sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is null`,
      sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace' is null`,
      input.runIds?.length ? inArray(nativeRunFinalizations.runId, input.runIds) : undefined,
    ));

  const released: Array<{ runId: string; reason: string }> = [];
  for (const row of candidates) {
    if (input.liveRunExecutions?.has(row.runId)) continue;
    const takeover = await evaluateNativeControllerTakeover({
      owner: row, now: input.now, requireStoppedController: true,
      ...(input.isProcessAlive ? { isProcessAlive: input.isProcessAlive } : {}),
      ...(input.readProcessStartedAt ? { readProcessStartedAt: input.readProcessStartedAt } : {}),
    });
    if (!takeover.allowed) continue;
    const updated = await db.transaction(async tx => {
      await notifyLiveRunRecovery(tx, { companyId: row.companyId, runId: row.runId, agentId: row.agentId });
      await notifyNativeResultCommit(tx, { companyId: row.companyId, runId: row.runId, issueId: row.issueId });
      await notifyNativeFinalizationWork(tx, { companyId: row.companyId, runId: row.runId });
      // Compare-and-set on the exact dead owner, so a lease taken over since
      // the scan is never cut short. Each lease owner token is unique; the
      // stored expiry is not compared because Postgres keeps microseconds that
      // a JavaScript Date drops.
      return tx.update(nativeRunFinalizations).set({ leaseExpiresAt: input.now, updatedAt: input.now })
        .where(and(
          eq(nativeRunFinalizations.runId, row.runId),
          eq(nativeRunFinalizations.leaseOwner, row.leaseOwner!),
          gt(nativeRunFinalizations.leaseExpiresAt, input.now),
          eq(nativeRunFinalizations.controllerBootId, row.controllerBootId!),
          eq(nativeRunFinalizations.controllerHostHash, hostHash),
          row.controllerPid === null ? isNull(nativeRunFinalizations.controllerPid)
            : eq(nativeRunFinalizations.controllerPid, row.controllerPid),
        ))
        .returning({ runId: nativeRunFinalizations.runId })
        .then(async rows => {
          if (rows.length) await recordLegacyHostFallbackProof(tx as unknown as Db,
            { companyId: row.companyId, id: row.runId, agentId: row.agentId }, takeover, "dead_controller_result_lease");
          return rows;
        });
    });
    if (updated.length) released.push({ runId: row.runId, reason: takeover.reason });
  }
  return released;
}
