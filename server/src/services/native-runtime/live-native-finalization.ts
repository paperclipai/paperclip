import type { Db } from "@paperclipai/db";
import { notifyNativeResultCommit } from "../native-result-commit-notifications.js";
import { notifyNativeWorkspaceFinalization, releaseNativeWorkspaceFinalization } from "../native-workspace-finalization-notifications.js";
import { logger } from "../../middleware/logger.js";

// Runs whose live heartbeat in this process will export the workspace and
// commit the accepted result itself. A runner posts its result before its
// process returns, and that post wakes the recovery workers. Without this
// reservation a worker could take the run from the heartbeat that is still
// finishing it, and the run would lose its exit code, log summary and usage.
const reservedRuns = new Map<string, number>();

export function liveNativeFinalizationReserved(runId: string): boolean {
  return reservedRuns.has(runId);
}

/**
 * Hold a run for its live heartbeat. The returned release never throws. It
 * wakes the workers for this run, so they resume anything the heartbeat left
 * unfinished; the result worker also rechecks a reserved run on its own. A
 * crashed process loses the reservation, and startup recovery takes over.
 */
export function reserveLiveNativeFinalization(db: Db, scope: { companyId: string; runId: string; issueId?: string }) {
  reservedRuns.set(scope.runId, (reservedRuns.get(scope.runId) ?? 0) + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const remaining = (reservedRuns.get(scope.runId) ?? 1) - 1;
    if (remaining > 0) reservedRuns.set(scope.runId, remaining);
    else reservedRuns.delete(scope.runId);
    if (remaining > 0) return;
    try {
      await db.transaction(async (tx) => {
        await notifyNativeWorkspaceFinalization(tx, scope);
        await notifyNativeResultCommit(tx, scope);
      });
    } catch (error) {
      // Startup and periodic discovery still find the run.
      logger.warn({ err: error, runId: scope.runId }, "native finalization workers could not be woken after the live heartbeat");
    }
    try {
      releaseNativeWorkspaceFinalization(db, scope);
    } catch (error) {
      logger.warn({ err: error, runId: scope.runId }, "native workspace finalization could not be woken after the live heartbeat");
    }
  };
}
