import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { readNativeProcessEvidence } from "./native-process-evidence.js";

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
  const event = await readNativeProcessEvidence(db, companyId, runId);
  return event?.eventType === LOCAL_PROCESS_STOPPED;
}

/** Pre-receipt native runs can retain an exact suspended session after their
 * mutable process fields were cleared. This is admission evidence for a new
 * user turn only, never permission to replay the old run or infer its outcomes.
 * The caller must hold the run/controller locks and verify local lease cleanup.
 */
export async function hasHistoricalSuspendedNativeSession(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.runtimeMode !== "native" || run.processPid || run.processGroupId ||
      !run.nativeSessionId || !run.runnerInstanceId || !run.nativeIssueId) return false;
  const modernProcessEvidence = await readNativeProcessEvidence(db, run.companyId, run.id);
  // A newer launch invalidates an old stop receipt. Never bypass that fence
  // with a suspended file that could belong to the earlier process generation.
  if (modernProcessEvidence?.eventType) return false;
  const checkpoint = run.runnerProfileJson?.sessionCheckpoint as Record<string, unknown> | undefined;
  if (checkpoint?.providerSessionId != null && (typeof checkpoint.providerSessionId !== "string" ||
      !checkpoint.providerSessionId.trim())) return false;
  const { nativeFailedRunRetryStateIsSafe } = await import("./native-runtime/native-session-executor.js");
  return (await nativeFailedRunRetryStateIsSafe({
    db,
    execution: run.runnerProfileJson?.nativeExecutionInput,
    companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, runId: run.id,
    nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
    processPid: null, processGroupId: null,
    providerSessionId: typeof checkpoint?.sessionId === "string" ? checkpoint.sessionId : null,
    providerBackendSessionId: typeof checkpoint?.providerSessionId === "string" ? checkpoint.providerSessionId : null,
    recoveryMode: "exact_checkpoint_resume", allowVerifiedBackup: false,
  }));
}

/** Recover the exact stopped identity after the mutable run fields were cleared. */
export async function readNativeLocalProcessStop(db: Db, companyId: string, runId: string) {
  const event = await readNativeProcessEvidence(db, companyId, runId);
  const pid = event?.processPid;
  const group = event?.processGroupId;
  if (event?.eventType !== LOCAL_PROCESS_STOPPED || typeof pid !== "number" ||
      !Number.isSafeInteger(pid) || pid <= 1 || group !== pid || !absent(pid) || !absent(-pid)) return null;
  return { processPid: pid, processGroupId: pid };
}
