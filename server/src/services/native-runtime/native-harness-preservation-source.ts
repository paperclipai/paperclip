import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentTaskSessions, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { nativeSha256 } from "./canonical.js";
import { tryLockNativeWorkspaceFinalization } from "./native-workspace-finalization-ownership.js";
import { nativeHarnessStateBase, readNativeHarnessBackupStamp, verifyNativeHarnessBackupStampAsync } from "./native-harness-backup-stamp.js";
import { readNativeHarnessBackupSource } from "./native-harness-backup-source.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
type Lease = typeof environmentLeases.$inferSelect;
export type SettledNativeHarnessBackupOwner = {
  kind: "settled_native_harness_backup";
  companyId: string; issueId: string; agentId: string; runId: string;
  sessionId: string; runnerInstanceId: string; scopeDigest: string; root: string; manifestSha256: string;
  selectedSessionId: string; selectedLastRunId: string; sourceLeaseId: string; providerLeaseId: string;
  runDigest: string; coordinatorDigest: string; leaseDigest: string;
};
const runDigest = (run: Run) => nativeSha256({ status: run.status, finishedAt: run.finishedAt?.toISOString(),
  controllerBootId: run.controllerBootId, controllerLeaseExpiresAt: run.controllerLeaseExpiresAt?.toISOString(),
  processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt?.toISOString(),
  runnerInstanceId: run.runnerInstanceId, runnerProfileJson: run.runnerProfileJson });
const coordinatorDigest = (row: Coordinator) => nativeSha256({ phase: row.phase, resultId: row.resultId,
  controllerBootId: row.controllerBootId, controllerGeneration: row.controllerGeneration, recoveryState: row.recoveryState });
const leaseDigest = (row: Lease) => nativeSha256({ heartbeatRunId: row.heartbeatRunId, status: row.status,
  releasedAt: row.releasedAt?.toISOString(), cleanupStatus: row.cleanupStatus, providerLeaseId: row.providerLeaseId,
  nativeHarnessBackup: row.metadata?.nativeHarnessBackup });
const settled = (row: Coordinator) => row.leaseOwner === null && row.nextAttemptAt === null
  && (row.phase === "terminal_failure" || row.phase === "committed" && row.resultId !== null);
const fail = (): never => { throw new Error("native_harness_preservation_source_unsettled"); };

/** Copy sealed historical files without certifying provider termination, changing
 * a failed run, or taking an expired coordinator. Every publication rechecks it. */
export async function settledNativeHarnessBackupOwner(db: Db, input: {
  companyId: string; issueId: string; runId: string; sessionId: string; runnerInstanceId: string;
  scopeDigest: string; root: string; manifestSha256: string; providerLeaseId: string; signal: AbortSignal;
}): Promise<SettledNativeHarnessBackupOwner | null> {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.issueId, input.issueId), eq(nativeRunFinalizations.runId, input.runId)));
  if (!run || !coordinator || !settled(coordinator)) return null;
  const selected = await db.select({ id: agentTaskSessions.id, lastRunId: agentTaskSessions.lastRunId }).from(agentTaskSessions)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, agentTaskSessions.companyId), eq(heartbeatRuns.agentId, agentTaskSessions.agentId),
      eq(heartbeatRuns.id, agentTaskSessions.lastRunId))).where(and(eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.agentId, run.agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.nativeSessionId, input.sessionId))).limit(2);
  if (selected.length !== 1 || !selected[0]!.lastRunId) return null;
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.issueId, input.issueId), eq(environmentLeases.providerLeaseId, input.providerLeaseId),
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'manifestSha256' = ${input.manifestSha256}`));
  const lease = leases.find(row => readNativeHarnessBackupStamp(row.metadata?.nativeHarnessBackup, input.providerLeaseId)?.sessionScopeSha256 === input.scopeDigest);
  if (!lease) return null;
  const owner: SettledNativeHarnessBackupOwner = { kind: "settled_native_harness_backup", companyId: input.companyId,
    issueId: input.issueId, agentId: run.agentId, runId: input.runId, sessionId: input.sessionId, runnerInstanceId: input.runnerInstanceId,
    scopeDigest: input.scopeDigest, root: input.root, manifestSha256: input.manifestSha256,
    selectedSessionId: selected[0]!.id, selectedLastRunId: selected[0]!.lastRunId,
    sourceLeaseId: lease.id, providerLeaseId: input.providerLeaseId,
    runDigest: runDigest(run), coordinatorDigest: coordinatorDigest(coordinator), leaseDigest: leaseDigest(lease) };
  await db.transaction(tx => assertSettledNativeHarnessBackupSource(tx as unknown as Db, owner, input.signal));
  return owner;
}

export async function assertSettledNativeHarnessBackupSource(db: Db, owner: SettledNativeHarnessBackupOwner,
  signal = AbortSignal.timeout(300_000)) {
  signal.throwIfAborted();
  await db.execute(sql`set local lock_timeout = '1s'`);
  if (!await tryLockNativeWorkspaceFinalization(db, owner)) fail();
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, owner.companyId), eq(issues.id, owner.issueId))).for("update");
  if (!task || task.executionRunId || task.checkoutRunId) fail();
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, owner.companyId),
    eq(nativeRunFinalizations.issueId, owner.issueId), eq(nativeRunFinalizations.runId, owner.runId))).for("update");
  if (!coordinator || !settled(coordinator) || coordinatorDigest(coordinator) !== owner.coordinatorDigest) fail();
  const [selection] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, owner.companyId),
    eq(agentTaskSessions.agentId, owner.agentId), eq(agentTaskSessions.id, owner.selectedSessionId),
    eq(agentTaskSessions.adapterType, "paperclip_runner"),
    eq(agentTaskSessions.lastRunId, owner.selectedLastRunId))).for("share");
  const [selectedRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, owner.companyId),
    eq(heartbeatRuns.agentId, owner.agentId), eq(heartbeatRuns.id, owner.selectedLastRunId),
    eq(heartbeatRuns.nativeIssueId, owner.issueId), eq(heartbeatRuns.nativeSessionId, owner.sessionId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, owner.companyId),
    eq(heartbeatRuns.agentId, owner.agentId), eq(heartbeatRuns.id, owner.runId), eq(heartbeatRuns.nativeIssueId, owner.issueId),
    eq(heartbeatRuns.nativeSessionId, owner.sessionId), eq(heartbeatRuns.runnerInstanceId, owner.runnerInstanceId), eq(heartbeatRuns.runtimeMode, "native"))).for("share");
  const [clock] = await db.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
  if (!selection || !selectedRun || !run?.finishedAt || !["failed", "cancelled", "interrupted", "timed_out"].includes(run.status)
    || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date(clock.now)
    || adapterExecutionControls.has(run.id) || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null
    || runDigest(run) !== owner.runDigest) fail();
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, owner.companyId),
    inArray(heartbeatRuns.status, ["queued", "running"]), or(eq(heartbeatRuns.nativeIssueId, owner.issueId),
      eq(heartbeatRuns.issueId, owner.issueId), eq(heartbeatRuns.nativeSessionId, owner.sessionId)))).limit(1);
  if (active) fail();
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, owner.sourceLeaseId),
    eq(environmentLeases.companyId, owner.companyId), eq(environmentLeases.issueId, owner.issueId),
    eq(environmentLeases.providerLeaseId, owner.providerLeaseId))).for("share");
  const stamp = readNativeHarnessBackupStamp(lease?.metadata?.nativeHarnessBackup, owner.providerLeaseId);
  if (!lease || !stamp || leaseDigest(lease) !== owner.leaseDigest || stamp.sessionScopeSha256 !== owner.scopeDigest
    || stamp.manifestSha256 !== owner.manifestSha256 || stamp.normalizedSessionId !== owner.sessionId
    || stamp.runnerInstanceId !== owner.runnerInstanceId) fail();
  if (!/^[a-f0-9]{64}$/.test(owner.scopeDigest)
    || resolve(owner.root) !== resolve(nativeHarnessStateBase(), owner.scopeDigest, "failover-backups", "current")) fail();
  const source = await readNativeHarnessBackupSource(owner.root);
  if (!source || source.state.runId !== owner.runId || source.state.lifecycle !== "suspended"
    || `sha256:${createHash("sha256").update(source.manifestBytes).digest("hex")}` !== owner.manifestSha256
    || !await verifyNativeHarnessBackupStampAsync(stamp, owner.providerLeaseId, signal, owner.root)) fail();
}
