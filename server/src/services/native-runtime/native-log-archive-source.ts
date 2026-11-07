import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";

export type NativeLogArchiveSource = {
  id: string; companyId: string; agentId: string; status: string;
  logRef: string | null; bytes: number | null; sha256: string | null;
};

async function readSource(db: Db, source: NativeLogArchiveSource, lock: boolean, expected?: string) {
  function fail(): never { throw new Error("native_log_archive_source_unsettled"); }
  if (source.logRef !== `${source.companyId}/${source.agentId}/${source.id}.ndjson`) fail();
  if (lock && !await tryLockNativeWorkspaceFinalization(db, { companyId: source.companyId, runId: source.id }))
    throw new Error("native_log_archive_source_busy");
  const scope = and(eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, source.companyId));
  const owners = db.select({ issueId: nativeRunFinalizations.issueId, phase: nativeRunFinalizations.phase,
    resultId: nativeRunFinalizations.resultId, recoveryState: nativeRunFinalizations.recoveryState,
    leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    nextAttemptAt: nativeRunFinalizations.nextAttemptAt, controllerGeneration: nativeRunFinalizations.controllerGeneration,
    attempt: nativeRunFinalizations.attempt, controllerBootId: nativeRunFinalizations.controllerBootId,
    controllerPid: nativeRunFinalizations.controllerPid, controllerProcessStartedAt: nativeRunFinalizations.controllerProcessStartedAt,
  }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, source.id), eq(nativeRunFinalizations.companyId, source.companyId)));
  const [owner] = await (lock ? owners.for("update") : owners);
  const rows = db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, runtimeMode: heartbeatRuns.runtimeMode,
    issueId: heartbeatRuns.nativeIssueId, sessionId: heartbeatRuns.nativeSessionId,
    logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef, bytes: heartbeatRuns.logBytes, sha256: heartbeatRuns.logSha256,
    processGroupId: heartbeatRuns.processGroupId,
    physicalOwner: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner' <> 'null'::jsonb, false)`,
  }).from(heartbeatRuns).where(scope);
  const [run] = await (lock ? rows.for("update") : rows);
  if (!run || !owner || !run.issueId || !run.sessionId || run.runtimeMode !== "native" || !run.finishedAt
    || run.agentId !== source.agentId || run.status !== source.status
    || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)
    || run.logStore !== "local_file" || run.logRef !== source.logRef || run.bytes !== source.bytes || run.sha256 !== source.sha256
    || run.processGroupId !== null || run.physicalOwner || owner.issueId !== run.issueId
    || owner.leaseOwner !== null || owner.leaseExpiresAt !== null || owner.nextAttemptAt !== null
    || !(owner.phase === "committed" && owner.resultId !== null && owner.recoveryState === null
      || owner.phase === "terminal_failure" && run.status !== "succeeded"
        && (owner.recoveryState === null || owner.recoveryState === "blocked"))) fail();
  const [task] = await db.select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
    .from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, run.issueId)));
  const [allocation] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    sql`${environmentLeases.releasedAt} is null`)).limit(1);
  const [alias] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    ne(heartbeatRuns.id, run.id), eq(heartbeatRuns.logStore, "local_file"), eq(heartbeatRuns.logRef, run.logRef!))).limit(1);
  if (!task || task.executionRunId === run.id || task.checkoutRunId === run.id || allocation || alias) fail();
  const fence = nativeSha256({ ...run, finishedAt: run.finishedAt.toISOString(), owner: { phase: owner.phase, generation: owner.controllerGeneration,
    attempt: owner.attempt, bootId: owner.controllerBootId, pid: owner.controllerPid,
    startedAt: owner.controllerProcessStartedAt?.toISOString() ?? null, resultId: owner.resultId, recoveryState: owner.recoveryState } });
  if (expected && fence !== expected) throw new Error("native_log_archive_source_changed");
  return fence;
}

export async function inspectNativeLogArchiveSource(db: Db, source: NativeLogArchiveSource) {
  return readSource(db, source, false);
}

export async function withNativeLogArchiveSource<T>(db: Db, source: NativeLogArchiveSource, expected: string | undefined,
  action: (tx: Db, fence: string) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout='1s'`);
    const fence = await readSource(tx as unknown as Db, source, true, expected);
    return action(tx as unknown as Db, fence);
  });
}
