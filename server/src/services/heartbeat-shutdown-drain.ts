import { inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

const SHUTDOWN_DRAIN_ERROR = "Server shutdown — stale heartbeat-run lock cleanup.";
const SHUTDOWN_DRAIN_ERROR_CODE = "server_shutdown_stale_lock_cleanup";

export interface DrainStaleHeartbeatRunsResult {
  runsTerminated: number;
  issuesUnlocked: number;
}

/**
 * On graceful shutdown (SIGINT/SIGTERM), terminate every still-live
 * heartbeat run row (queued / running / scheduled_retry) and clear the
 * `executionRunId` / `checkoutRunId` locks pointing at those runs on the
 * `issues` table. Without this, a clean shutdown leaves the run row in
 * "running" status and the next checkout from the same agent hits a 409
 * because the prior lock is still considered live.
 *
 * Best-effort: returns `null` on any DB failure and never throws.
 */
export async function drainStaleHeartbeatRunsOnShutdown(
  db: Db,
): Promise<DrainStaleHeartbeatRunsResult | null> {
  try {
    const now = new Date();
    const liveRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]));
    if (liveRuns.length === 0) {
      return { runsTerminated: 0, issuesUnlocked: 0 };
    }
    const liveRunIds = liveRuns.map((r) => r.id);

    const unlockedByExecution = await db
      .update(issues)
      .set({
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(inArray(issues.executionRunId, liveRunIds))
      .returning({ id: issues.id });

    // Also clear `checkoutRunId` locks pointing at these runs but whose
    // `executionRunId` was already null (so the previous UPDATE skipped them).
    const unlockedByCheckoutOnly = await db
      .update(issues)
      .set({
        checkoutRunId: null,
        updatedAt: now,
      })
      .where(inArray(issues.checkoutRunId, liveRunIds))
      .returning({ id: issues.id });

    const terminated = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: SHUTDOWN_DRAIN_ERROR,
        errorCode: SHUTDOWN_DRAIN_ERROR_CODE,
        updatedAt: now,
      })
      .where(inArray(heartbeatRuns.id, liveRunIds))
      .returning({ id: heartbeatRuns.id });

    const result: DrainStaleHeartbeatRunsResult = {
      runsTerminated: terminated.length,
      issuesUnlocked: unlockedByExecution.length + unlockedByCheckoutOnly.length,
    };
    logger.info(result, "Cleared stale heartbeat-run locks on shutdown");
    return result;
  } catch (err) {
    logger.warn({ err }, "Stale heartbeat-run drain on shutdown failed");
    return null;
  }
}

export const __INTERNAL_FOR_TESTS = {
  LIVE_HEARTBEAT_RUN_STATUSES,
  SHUTDOWN_DRAIN_ERROR_CODE,
};
