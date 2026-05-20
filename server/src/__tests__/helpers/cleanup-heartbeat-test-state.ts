import { eq, inArray, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  type createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import type { heartbeatService } from "../../services/heartbeat.ts";

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

export type CleanupHeartbeatTestStateOptions = {
  /**
   * Tables to TRUNCATE alongside "companies". The companies cascade covers
   * every company-scoped table by FK. Singleton tables that aren't
   * company-scoped (e.g. "instance_settings") must be listed here.
   */
  extraTruncateTables?: readonly string[];
  /**
   * Free-text used in the cancellation error column for active heartbeat
   * runs flipped to 'cancelled' during cleanup. Surfaces in the run row
   * if a test ever inspects post-cleanup state.
   */
  errorLabel?: string;
  /**
   * Wall-clock budget for the cancel→idle loop. Default 5_000ms.
   */
  cancelTimeoutMs?: number;
  /**
   * Wall-clock budget for `heartbeat.drainInFlightExecutions`. Default
   * 10_000ms.
   */
  drainTimeoutMs?: number;
};

/**
 * Canonical cleanup for any test that exercises `heartbeatService`.
 *
 * The v513 saga (PRs #55/#61/#72/#81/#91/#92/#94/#96) found three layers of
 * race between heartbeat dispatcher work and test cleanup. This helper
 * encodes the proven sequence:
 *
 *   1. Cancel queued/running heartbeat_runs (and their wakeup_requests)
 *      so the dispatcher and in-flight executeRun chains observe
 *      cancellation. Loop until row-status settles, bounded by
 *      cancelTimeoutMs.
 *
 *   2. Await `heartbeat.drainInFlightExecutions()` (heartbeat.ts ~line
 *      10895, added by PR #96). This is the root-cause fix: the
 *      dispatcher fires `void executeRun(...)` as fire-and-forget; the
 *      drain awaits those spawned promises (including recursive
 *      dispatches) so postRun lifecycle hooks finish their writes
 *      BEFORE the TRUNCATE.
 *
 *   3. `TRUNCATE TABLE "companies", <extras> CASCADE` — single statement
 *      drops every FK-related row in one shot, immune to the per-table
 *      ordering races that surfaced as "delete from companies violates
 *      ... FK on document_revisions" in dep-sched (master verify_canary
 *      run 26136174642).
 *
 * Tests that previously had a bespoke `cancelActiveRunsForCleanup`
 * helper, a pg_terminate_backend statement, a 3-retry on 40P01, or a
 * triple-confirm idle poll should all collapse into one call here.
 *
 * Production code never calls this — it lives under `__tests__/helpers/`.
 *
 * Usage:
 *
 *   afterEach(async () => {
 *     await cleanupHeartbeatTestState(db, heartbeat);
 *   });
 *
 * With extras for tests that touch instance_settings:
 *
 *   afterEach(async () => {
 *     await cleanupHeartbeatTestState(db, heartbeat, {
 *       extraTruncateTables: ["instance_settings"],
 *     });
 *   });
 */
export async function cleanupHeartbeatTestState(
  db: Db,
  heartbeat: Pick<Heartbeat, "drainInFlightExecutions">,
  options: CleanupHeartbeatTestStateOptions = {},
): Promise<void> {
  const {
    extraTruncateTables = [],
    errorLabel = "test cleanup",
    cancelTimeoutMs = 5_000,
    drainTimeoutMs = 10_000,
  } = options;

  await cancelActiveRunsForCleanup(db, errorLabel, cancelTimeoutMs);
  await heartbeat.drainInFlightExecutions(drainTimeoutMs);

  const truncateList = ['"companies"', ...extraTruncateTables.map((t) => `"${t}"`)].join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${truncateList} CASCADE`));
}

async function cancelActiveRunsForCleanup(
  db: Db,
  errorLabel: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (activeRuns.length === 0) return;
    const now = new Date();
    const runIds = activeRuns.map((run) => run.id);
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    const cancellationMessage = `Cancelled by ${errorLabel}`;
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: cancellationMessage,
      })
      .where(inArray(heartbeatRuns.id, runIds));
    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: cancellationMessage,
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
