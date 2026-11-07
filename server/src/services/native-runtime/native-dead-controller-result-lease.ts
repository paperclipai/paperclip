import { and, eq, gt, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { notifyLiveRunRecovery } from "../live-run-recovery-notifications.js";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import { currentNativeControllerIdentity, evaluateNativeControllerTakeover } from "./native-restart-recovery.js";

type TakeoverProbe = Pick<Parameters<typeof evaluateNativeControllerTakeover>[0], "isProcessAlive" | "readProcessStartedAt">;

/**
 * A hard kill (SIGKILL, OOM, host crash) after `run.result` is accepted leaves
 * the result leased to a controller of an earlier boot. A graceful drain expires
 * that lease itself; a killed process cannot. Without this release, result
 * finalization waits the full lease (up to 20 minutes) and the run stays
 * `running` with its follow-up work held.
 *
 * Ownership is proved by controller identity, never by lease age: the lease
 * belongs to a different boot and its recorded controller process has exited
 * (or its PID now names a different process). A live or unidentifiable owner
 * keeps its lease. Remote workspaces keep their fenced lease semantics.
 */
export async function releaseDeadControllerResultLeases(db: Db, input: {
  now: Date;
  runIds?: string[];
  liveRunExecutions?: { has(runId: string): boolean };
} & TakeoverProbe): Promise<Array<{ runId: string; reason: string }>> {
  const controller = await currentNativeControllerIdentity();
  const candidates = await db.select({
    runId: nativeRunFinalizations.runId,
    companyId: nativeRunFinalizations.companyId,
    issueId: nativeRunFinalizations.issueId,
    agentId: heartbeatRuns.agentId,
    leaseOwner: nativeRunFinalizations.leaseOwner,
    leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    controllerBootId: nativeRunFinalizations.controllerBootId,
    controllerPid: nativeRunFinalizations.controllerPid,
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
      gt(nativeRunFinalizations.leaseExpiresAt, input.now),
      isNotNull(nativeRunFinalizations.controllerBootId),
      ne(nativeRunFinalizations.controllerBootId, controller.bootId),
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
      // Compare-and-set on the exact dead owner, so a lease renewed or taken
      // over since the scan is never cut short.
      return tx.update(nativeRunFinalizations).set({ leaseExpiresAt: input.now, updatedAt: input.now })
        .where(and(
          eq(nativeRunFinalizations.runId, row.runId),
          eq(nativeRunFinalizations.leaseOwner, row.leaseOwner!),
          eq(nativeRunFinalizations.leaseExpiresAt, row.leaseExpiresAt!),
          eq(nativeRunFinalizations.controllerBootId, row.controllerBootId!),
          row.controllerPid === null ? isNull(nativeRunFinalizations.controllerPid)
            : eq(nativeRunFinalizations.controllerPid, row.controllerPid),
        ))
        .returning({ runId: nativeRunFinalizations.runId });
    });
    if (updated.length) released.push({ runId: row.runId, reason: takeover.reason });
  }
  return released;
}
