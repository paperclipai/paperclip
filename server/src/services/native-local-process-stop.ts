import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { nativeSessionProviderEvidence } from "./native-runtime/native-session-resume.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import os from "node:os";

export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";
const LOCAL_PROCESS_STOPPED = "native.local_process_stopped";
const SETTLED_RUN_STATUSES = ["failed", "cancelled", "timed_out", "interrupted"];
const SETTLED_COORDINATOR_PHASES = ["committed", "terminal_failure"];

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A fresh workspace is not process containment. Bind an OS observation to
 * the original host, process birth, and launch event before accepting it. */
export async function recordedLocalExecutionStopped(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "processPid" | "processGroupId" | "processStartedAt">) {
  const [identity] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, PROCESS_IDENTITY_RECORDED), isNull(heartbeatRunEvents.sourceEventId),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const recorded = identity?.payload;
  if (recorded?.targetKind !== "local" || recorded.hostname !== os.hostname() ||
      recorded.processPid !== run.processPid || recorded.processGroupId !== run.processGroupId ||
      !run.processStartedAt || recorded.processStartedAt !== run.processStartedAt.toISOString()) return false;
  return Boolean(run.processPid && absent(run.processPid) &&
    (!run.processGroupId || absent(-run.processGroupId)));
}

/**
 * Preserve the host's observation before recovery clears the process fields.
 * Call in the same transaction as that compare-and-set. Never inspect remote
 * process IDs in the control-plane host's process table.
 */
export async function recordNativeLocalProcessStop(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "runtimeMode" | "processPid" | "processGroupId" | "processStartedAt">) {
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
    payload: { processPid: run.processPid, processGroupId: run.processGroupId,
      processStartedAt: run.processStartedAt?.toISOString() ?? null },
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

/** Pre-receipt native runs can retain an exact suspended session after their
 * mutable process fields were cleared. This is admission evidence for a new
 * user turn only, never permission to replay the old run or infer its outcomes.
 * The caller must hold the run/controller locks and verify local lease cleanup.
 */
export async function hasHistoricalSuspendedNativeSession(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.runtimeMode !== "native" || run.processPid || run.processGroupId ||
      !run.nativeSessionId || !run.runnerInstanceId || !run.nativeIssueId) return false;
  const [modernProcessEvidence] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
  )).limit(1);
  // A newer launch invalidates an old stop receipt. Never bypass that fence
  // with a suspended file that could belong to the earlier process generation.
  if (modernProcessEvidence) return false;
  const checkpoint = run.runnerProfileJson?.sessionCheckpoint as Record<string, unknown> | undefined;
  if (checkpoint?.providerSessionId != null && (typeof checkpoint.providerSessionId !== "string" ||
      !checkpoint.providerSessionId.trim())) return false;
  const { nativeFailedRunRetryStateIsSafe } = await import("./native-runtime/native-session-executor.js");
  return nativeFailedRunRetryStateIsSafe({
    execution: run.runnerProfileJson?.nativeExecutionInput,
    companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, runId: run.id,
    nativeSessionId: run.nativeSessionId, runnerInstanceId: run.runnerInstanceId,
    processPid: null, processGroupId: null,
    providerSessionId: typeof checkpoint?.sessionId === "string" ? checkpoint.sessionId : null,
    providerBackendSessionId: typeof checkpoint?.providerSessionId === "string" ? checkpoint.providerSessionId : null,
    recoveryMode: "exact_checkpoint_resume", allowVerifiedBackup: false,
  });
}

export async function withReleasedNativeRunProcess<T extends {
  id: string; companyId: string; processPid: number | null; processGroupId: number | null; processStartedAt: Date | null;
}>(db: Db, run: T): Promise<T> {
  if (run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null) return run;
  const stopped = await readNativeLocalProcessStop(db, run.companyId, run.id);
  if (!stopped) return run;
  return { ...run, processPid: stopped.processPid, processGroupId: stopped.processGroupId,
    processStartedAt: stopped.processStartedAt ? new Date(stopped.processStartedAt) : null };
}

/** Recover the exact stopped identity after the mutable run fields were cleared. */
export async function readNativeLocalProcessStop(db: Db, companyId: string, runId: string) {
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED])))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const pid = event?.payload?.processPid;
  const group = event?.payload?.processGroupId;
  if (event?.eventType !== LOCAL_PROCESS_STOPPED || typeof pid !== "number" ||
      !Number.isSafeInteger(pid) || pid <= 1 || group !== pid || !absent(pid) || !absent(-pid)) return null;
  const startedAt = event.payload?.processStartedAt;
  return { processPid: pid, processGroupId: pid,
    ...(typeof startedAt === "string" ? { processStartedAt: startedAt } : {}) };
}

type SettledProcessRelease = "released" | "pending" | "skipped";

export async function releaseSettledNativeRunProcess(db: Db, runId: string): Promise<SettledProcessRelease> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
      processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt,
      hasSessionCheckpoint: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint', 'null'::jsonb) <> 'null'::jsonb`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update").limit(1);
    if (!run || run.runtimeMode !== "native" || !SETTLED_RUN_STATUSES.includes(run.status) || !run.finishedAt ||
        (run.processPid === null && run.processGroupId === null && run.processStartedAt === null)) return "skipped";
    const [coordinator] = await tx.select({ phase: nativeRunFinalizations.phase }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, run.id)).limit(1);
    if (coordinator && !SETTLED_COORDINATOR_PHASES.includes(coordinator.phase)) return "skipped";
    if (!run.hasSessionCheckpoint &&
        !(await nativeSessionProviderEvidence(tx, [run.id])).has(run.id)) return "skipped";
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    ));
    if (leases.some(lease => lease.provider !== "local")) {
      if (!leases.every(hasRemoteTerminationReceipt)) return "pending";
    } else {
      if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "pending";
      const [identity] = await tx.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
        eq(heartbeatRunEvents.eventType, PROCESS_IDENTITY_RECORDED), isNull(heartbeatRunEvents.sourceEventId),
      )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
      if (identity?.payload?.targetKind !== "local" || identity.payload.hostname !== os.hostname() ||
          identity.payload.processPid !== run.processPid || identity.payload.processGroupId !== run.processGroupId) return "skipped";
      if (!(await recordNativeLocalProcessStop(tx, run))) return "pending";
    }
    await tx.update(heartbeatRuns).set({
      processPid: null, processGroupId: null, processStartedAt: null, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, run.id));
    return "released";
  });
}

const MAX_SETTLED_PROCESS_RELEASE_ATTEMPTS = 20;
const pendingSettledProcessReleases = new Map<string, number>();

export async function settleNativeRunProcess(db: Db, runId: string) {
  const outcome = await releaseSettledNativeRunProcess(db, runId);
  const attempts = (pendingSettledProcessReleases.get(runId) ?? 0) + 1;
  if (outcome === "pending" && attempts < MAX_SETTLED_PROCESS_RELEASE_ATTEMPTS) {
    pendingSettledProcessReleases.set(runId, attempts);
  } else {
    pendingSettledProcessReleases.delete(runId);
  }
  return outcome;
}

export function pendingSettledNativeRunProcessIds() {
  return [...pendingSettledProcessReleases.keys()];
}

export async function retryPendingSettledNativeRunProcesses(db: Db, input: { skip?: (runId: string) => boolean } = {}) {
  for (const runId of pendingSettledNativeRunProcessIds()) {
    if (input.skip?.(runId)) continue;
    await settleNativeRunProcess(db, runId);
  }
}

export async function discoverSettledNativeRunProcesses(db: Db, input: {
  limit?: number; skip?: (runId: string) => boolean;
} = {}) {
  const limit = input.limit ?? 50;
  let after: string | null = null;
  let released = 0;
  do {
    const candidates: Array<{ id: string }> = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.runtimeMode, "native"),
      inArray(heartbeatRuns.status, SETTLED_RUN_STATUSES),
      isNotNull(heartbeatRuns.finishedAt),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), isNotNull(heartbeatRuns.processStartedAt)),
      ...(after ? [gt(heartbeatRuns.id, after)] : []),
    )).orderBy(asc(heartbeatRuns.id)).limit(limit);
    for (const candidate of candidates) {
      if (input.skip?.(candidate.id)) continue;
      if (await settleNativeRunProcess(db, candidate.id) === "released") released += 1;
    }
    after = candidates.length < limit ? null : candidates.at(-1)!.id;
  } while (after);
  return { released };
}
