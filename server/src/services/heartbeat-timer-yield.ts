import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

const NON_TIMER_PENDING_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * Synthetic `agents.lastHeartbeatAt` baseline so elapsed time since HB-007 tick baseline stays below
 * interval until roughly `deferSeconds` passes (unless `deferSeconds === 0`, which resets to “now”).
 */
export function computeDeferredTimerBaseline(nowMs: number, intervalSec: number, deferSeconds: number): Date {
  const intervalMs = Math.max(1000, Math.floor(intervalSec) * 1000);
  if (!Number.isFinite(deferSeconds) || deferSeconds <= 0) {
    return new Date(nowMs);
  }
  const deferMs = deferSeconds * 1000;
  if (deferMs >= intervalMs) {
    return new Date(nowMs);
  }
  return new Date(nowMs - intervalMs + deferMs);
}

/** Count runs that occupy the concurrency pipeline ahead of scheduler timer wakes. */
export async function countAgentNonTimerPendingRuns(db: Db, agentId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, [...NON_TIMER_PENDING_STATUSES]),
        ne(heartbeatRuns.invocationSource, "timer"),
      ),
    );
  return Number(row?.c ?? 0);
}
