import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";
const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Preserve the host's observation before recovery clears the process fields.
 * Call in the same transaction as that compare-and-set. Never inspect remote
 * process IDs in the control-plane host's process table.
 */
export async function recordNativeLocalProcessStop(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.runtimeMode !== "native" || (!run.processPid && !run.processGroupId)) return false;
  const leases = await db.select({ provider: environmentLeases.provider })
    .from(environmentLeases)
    .where(and(
      eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id),
    ));
  if (leases.some(lease => lease.provider !== "local")) return false;
  if ((run.processPid && !absent(run.processPid)) ||
      (run.processGroupId && !absent(-run.processGroupId))) return false;
  await appendHeartbeatRunEvent(db, {
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    eventType: LOCAL_PROCESS_STOPPED,
    stream: "system",
    level: "info",
    message: "Recovery verified the local process stopped before clearing its identity.",
    payload: { processPid: run.processPid, processGroupId: run.processGroupId },
  });
  return true;
}

/** Only server-authored evidence counts. A later launch invalidates the receipt. */
export async function hasNativeLocalProcessStop(db: Db, companyId: string, runId: string) {
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, companyId),
      eq(heartbeatRunEvents.runId, runId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
    ))
    .orderBy(desc(heartbeatRunEvents.seq))
    .limit(1);
  return event?.eventType === LOCAL_PROCESS_STOPPED;
}

/** Upgrade old cleared identities only from an exact, closed retained session.
 * New-format launches must use their normal stop receipt, never this fallback.
 */
export async function reconcileLegacyNativeLocalStop(
  db: Db, run: typeof heartbeatRuns.$inferSelect,
  coordinator: typeof nativeRunFinalizations.$inferSelect | undefined,
  dryRun: boolean,
): Promise<boolean> {
  if (!coordinator) return false;
  const [newFormat] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
  )).limit(1);
  if (newFormat) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (!leases.length || leases.some(lease => lease.provider !== "local" || !lease.releasedAt || lease.cleanupStatus === "failed")) return false;
  const { verifyRetainedLocalProcessStop } = await import("./native-runtime/native-session-executor.js");
  const proof = verifyRetainedLocalProcessStop(run, coordinator);
  if (!proof) return false;
  if (!dryRun) await appendHeartbeatRunEvent(db, {
    companyId: run.companyId, runId: run.id, agentId: run.agentId,
    eventType: LOCAL_PROCESS_STOPPED, stream: "system", level: "info",
    message: "Verified the stopped local provider from its retained session before continuing the user message.",
    payload: { ...proof, source: "retained_local_session_v1" },
  });
  return true;
}
