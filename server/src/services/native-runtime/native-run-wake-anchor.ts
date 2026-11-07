import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/** A slow database never holds a diagnostic longer than this. */
export const NATIVE_RUN_WAKE_ANCHOR_READ_TIMEOUT_MS = 2_000;

/**
 * When the durable wake request that created this run was accepted, in epoch
 * milliseconds. Diagnostic only: it anchors `task.time_to_first_token` to the
 * accepted input. Callers run it detached after the first deliverable text, so
 * it never adds a wait before `turn.start` or to event delivery. A failure or a
 * read slower than the timeout returns null.
 */
export async function readNativeRunWakeRequestedAtMs(
  db: Db,
  runId: string,
  timeoutMs = NATIVE_RUN_WAKE_ANCHOR_READ_TIMEOUT_MS,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([readWakeRequestedAtMs(db, runId), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readWakeRequestedAtMs(db: Db, runId: string): Promise<number | null> {
  try {
    const [row] = await db
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
  } catch {
    return null;
  }
}
