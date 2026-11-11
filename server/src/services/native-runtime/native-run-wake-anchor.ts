import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";

/** A slow database never holds this diagnostic longer than this. */
export const NATIVE_RUN_WAKE_ANCHOR_READ_TIMEOUT_MS = 2_000;

/**
 * When the durable wake request that created this run was accepted, in epoch
 * milliseconds. Diagnostic only: it anchors `task.time_to_first_token` to the
 * accepted input. Callers run it detached after the first deliverable text, so
 * it never adds a wait before `turn.start` or to event delivery.
 *
 * The read is bounded on both sides. PostgreSQL cancels the statement at
 * `timeoutMs` (a transaction-local `statement_timeout`, which also covers lock
 * waits), so a stalled read does not keep a shared connection busy after the
 * caller stops waiting. The caller also stops waiting at `timeoutMs`, which
 * covers a wait for a pool connection. Any failure returns null.
 */
export async function readNativeRunWakeRequestedAtMs(
  db: Db,
  runId: string,
  timeoutMs = NATIVE_RUN_WAKE_ANCHOR_READ_TIMEOUT_MS,
): Promise<number | null> {
  const boundedMs = Math.max(1, Math.floor(timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), boundedMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([readWakeRequestedAtMs(db, runId, boundedMs), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readWakeRequestedAtMs(db: Db, runId: string, timeoutMs: number): Promise<number | null> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`);
      const [row] = await tx
        .select({ requestedAt: agentWakeupRequests.requestedAt })
        .from(heartbeatRuns)
        .innerJoin(
          agentWakeupRequests,
          eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
        )
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      const at = row?.requestedAt?.getTime();
      return typeof at === "number" && Number.isFinite(at) ? at : null;
    });
  } catch {
    return null;
  }
}
