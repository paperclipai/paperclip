import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * When the durable wake request that created this run was accepted, in epoch
 * milliseconds. Diagnostic only: it anchors `task.time_to_first_token` to the
 * accepted input. Callers read it after the first deliverable text, so it never
 * adds a wait before `turn.start`. Any failure returns null.
 */
export async function readNativeRunWakeRequestedAtMs(
  db: Db,
  runId: string,
): Promise<number | null> {
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
