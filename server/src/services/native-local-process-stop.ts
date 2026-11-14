import { notifyLiveRunRecovery } from "./live-run-recovery-notifications.js";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { notifyRetainedNativeSessionCleanup } from "./retained-native-session-cleanup-notifications.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { NATIVE_SESSION_PROVIDER_EVENT_TYPES } from "./native-runtime/native-session-resume.js";
import os from "node:os";
import { currentProcessSpaceHash, UNKNOWN_PROCESS_SPACE } from "./controller-process-identity.js";
import { proveOwnerGone } from "./owner-proof.js";

export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";
/** Server-authored: the runner-state fence refused this run before it asked for
 * a runner, because a prior run's saved state could not be proven finished. */
export const PRIOR_OWNER_FENCE_REFUSED = "native.prior_owner_fence_refused";
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
  "id" | "companyId" | "processPid" | "processGroupId" | "processStartedAt"> & { processHostHash?: string | null }) {
  const [identity] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED]),
    isNull(heartbeatRunEvents.sourceEventId),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const recorded = identity?.payload;
  if (identity?.eventType !== PROCESS_IDENTITY_RECORDED || recorded?.targetKind !== "local" || recorded.hostname !== os.hostname() ||
      recorded.processPid !== run.processPid || recorded.processGroupId !== run.processGroupId ||
      !run.processStartedAt || recorded.processStartedAt !== run.processStartedAt.toISOString()) return false;
  if (!run.processPid) return false;
  // The shared prover judges the bound identity: the PID is dead or reused by
  // a later process, and its group is empty or led by a later process. The
  // recorded PID space is used when the row has one; older rows were bound to
  // this host by the launch event above.
  const proof = await proveOwnerGone({ kind: "local", scope: "native_local_process", generation: null, host: null,
    processSpace: run.processHostHash ?? currentProcessSpaceHash(), bootId: null, pid: run.processPid,
    processStartedAt: run.processStartedAt.toISOString(), processGroupId: run.processGroupId });
  return proof.verdict === "gone";
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
  await appendLocalProcessStop(db, { ...run, processStartedAt: run.processStartedAt?.toISOString() ?? null });
  return true;
}

async function appendLocalProcessStop(db: Db, run: { id: string; companyId: string; agentId: string;
  processPid: number | null; processGroupId: number | null; processStartedAt: string | null }) {
  await notifyDeliveryWork(db, DELIVERY_QUEUES.executionReplacement,
    JSON.stringify({ companyId: run.companyId, runId: run.id }));
  await appendHeartbeatRunEvent(db, {
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    eventType: LOCAL_PROCESS_STOPPED,
    stream: "system",
    level: "info",
    message: "Recovery verified the local process stopped before clearing its identity.",
    payload: { processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt },
  });
}

/** Transaction form for callers that clear the process identity: a stopped
 * provider closes its usage source, so accounting may settle a terminal run
 * whose final receipt can no longer arrive. */
export async function recordNativeLocalProcessStopInTransaction(tx: Db, run: Parameters<typeof recordNativeLocalProcessStop>[1]) {
  const recorded = await recordNativeLocalProcessStop(tx, run);
  if (recorded) await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, run.companyId);
  return recorded;
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

/**
 * A local runner launch can be requested and the server killed before the
 * runner's process identity is recorded. With no PID to check, prove on this
 * host that no runner for the run exists and that this launch wrote no runner
 * state (no provider can start before that), then record the stop like a
 * verified PID. A later launch request invalidates the receipt as usual.
 */
export async function recordUnidentifiedLocalRunnerStop(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "runtimeMode" | "processPid" | "processGroupId" | "runnerProfileJson">,
  options: { record: boolean } = { record: true }): Promise<boolean> {
  if (run.runtimeMode !== "native" || run.processPid || run.processGroupId) return false;
  const [latest, previous] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(2);
  // Only the host that requested the launch can inspect its process table.
  if (latest?.eventType !== PROCESS_START_REQUESTED || latest.payload?.hostname !== os.hostname()) return false;
  const leases = await db.select({ provider: environmentLeases.provider }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (leases.some(lease => lease.provider !== "local")) return false;
  const requestedAt = typeof latest.payload?.requestedAt === "string" ? Date.parse(latest.payload.requestedAt) : Number.NaN;
  const launchRequestedAt = (!previous || previous.eventType === LOCAL_PROCESS_STOPPED) && Number.isFinite(requestedAt)
    ? requestedAt : null;
  const { unidentifiedLocalRunnerProvenAbsent } = await import("./native-runtime/native-session-executor.js");
  if (!await unidentifiedLocalRunnerProvenAbsent({ runId: run.id, execution: run.runnerProfileJson?.nativeExecutionInput,
    launchRequestedAt })) return false;
  if (!options.record) return true;
  await appendHeartbeatRunEvent(db, {
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    eventType: LOCAL_PROCESS_STOPPED,
    stream: "system",
    level: "info",
    message: "Verified that no runner for this run exists on this host and none saved runner state after the launch request.",
    payload: { processPid: null, processGroupId: null, processStartedAt: null, basis: "unidentified_runner_absent" },
  });
  return true;
}

export class UnidentifiedRunnerStopRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "UnidentifiedRunnerStopRefusedError";
  }
}

type UnidentifiedLaunchRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "runtimeMode" | "status" | "finishedAt" | "processPid" | "processGroupId">;
type LaunchRefusal = { code: string; message: string } | "already_stopped" | null;

export async function unidentifiedLocalLaunchRefusals(db: Db, runs: UnidentifiedLaunchRun[]): Promise<Map<string, LaunchRefusal>> {
  const result = new Map<string, LaunchRefusal>();
  const candidates: UnidentifiedLaunchRun[] = [];
  for (const run of runs) {
    if (run.runtimeMode !== "native" || !run.finishedAt || !FINISHED_RUN_STATUSES.has(run.status))
      result.set(run.id, { code: "run_not_finished", message: "Only a finished run's stop can be confirmed." });
    else if (run.processPid || run.processGroupId)
      result.set(run.id, { code: "process_identity_recorded", message: "This run recorded its process. Paperclip verifies that process itself." });
    else candidates.push(run);
  }
  if (!candidates.length) return result;
  const ids = candidates.map(run => run.id);
  const companyIds = [...new Set(candidates.map(run => run.companyId))];
  const latest = await db.selectDistinctOn([heartbeatRunEvents.runId], { runId: heartbeatRunEvents.runId,
    eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    inArray(heartbeatRunEvents.companyId, companyIds), inArray(heartbeatRunEvents.runId, ids),
    isNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED]),
  )).orderBy(heartbeatRunEvents.runId, desc(heartbeatRunEvents.seq));
  const remote = new Set((await db.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
    inArray(environmentLeases.companyId, companyIds), inArray(environmentLeases.heartbeatRunId, ids),
    sql`${environmentLeases.provider} is distinct from 'local'`,
  ))).map(row => row.runId));
  const latestByRun = new Map(latest.map(row => [row.runId, row]));
  for (const run of candidates) {
    const event = latestByRun.get(run.id);
    result.set(run.id, event?.eventType === LOCAL_PROCESS_STOPPED ? "already_stopped"
      : event?.eventType !== PROCESS_START_REQUESTED
        ? { code: "no_unidentified_launch", message: "This run has no unconfirmed runner launch to stop." }
        : record(event.payload).hostname !== os.hostname()
          ? { code: "launch_on_other_host", message: "The runner was launched on another host. Confirm the stop there." }
          : remote.has(run.id)
            ? { code: "remote_environment", message: "This run used a remote environment. Its environment cleanup confirms the stop." }
            : null);
  }
  return result;
}

export async function unidentifiedLocalLaunchRefusal(db: Db, run: UnidentifiedLaunchRun): Promise<LaunchRefusal> {
  return (await unidentifiedLocalLaunchRefusals(db, [run])).get(run.id) ?? null;
}

export async function confirmUnidentifiedLocalRunnerStopped(db: Db, input: {
  companyId: string; issueId: string; runId: string; actorId: string;
}): Promise<{ runId: string; alreadyStopped: boolean }> {
  const refuse = (code: string, message: string) => { throw new UnidentifiedRunnerStopRefusedError(code, message); };
  const [run] = await db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run || ![run.issueId, run.nativeIssueId, record(run.contextSnapshot).issueId].includes(input.issueId))
    return refuse("run_not_found", "This run does not belong to the task.");
  const refusal = await unidentifiedLocalLaunchRefusal(db, run);
  if (refusal === "already_stopped") return { runId: run.id, alreadyStopped: true };
  if (refusal) return refuse(refusal.code, refusal.message);
  const { noLocalRunnerProcessForRun } = await import("./native-runtime/native-session-executor.js");
  if (!await noLocalRunnerProcessForRun(run.id))
    return refuse("runner_still_running", "A runner for this run is still running on this host. Stop it first.");
  await db.transaction(async tx => {
    const [locked] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
    const current = locked ? await unidentifiedLocalLaunchRefusal(tx as unknown as Db, locked) : null;
    if (!locked || current === "already_stopped" || current !== null || locked.finishedAt?.getTime() !== run.finishedAt?.getTime())
      return refuse("run_changed", "This run changed while its stop was being confirmed. Check it again.");
    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: LOCAL_PROCESS_STOPPED,
      stream: "system",
      level: "info",
      message: "A board operator confirmed that this run's runner and its agent processes have stopped.",
      payload: { processPid: null, processGroupId: null, processStartedAt: null, basis: "operator_attested",
        attestedByUserId: input.actorId },
    });
    await notifyDeliveryWork(tx as unknown as Db, DELIVERY_QUEUES.accounting, run.companyId);
  });
  return { runId: run.id, alreadyStopped: false };
}

const FINISHED_RUN_STATUSES = new Set(["failed", "cancelled", "timed_out", "succeeded", "interrupted"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A settled native run that never had a runner has nothing to stop:
 * - an admission fence (a quarantined prior-session cleanup) refused it before
 *   it requested a launch;
 * - the runner-state fence refused it before it requested a launch because a
 *   previous run still owns the conversation's saved runner state and that
 *   owner could not be proven finished. The executor records
 *   PRIOR_OWNER_FENCE_REFUSED before it fails the run. The root belonged to
 *   another run, so this run started nothing; or
 * - it failed before native selection (for example a refused budget
 *   reservation or a failed preparation query). Selection records the run's
 *   native issue, native session, runner instance and coordinator, and a
 *   runner launch needs them, so without any of them no runner or provider for this run can exist,
 *   in any build.
 * Any launch request, identity record or runner event keeps the normal stop
 * proofs. */
async function hasRunEvent(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">, eventType: string) {
  const [event] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNull(heartbeatRunEvents.sourceEventId), eq(heartbeatRunEvents.eventType, eventType),
  )).limit(1);
  return Boolean(event);
}

export async function nativeRunNeverLaunched(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "runtimeMode" | "status" | "errorCode" | "processPid" | "processGroupId" |
  "nativeSessionId" | "runnerInstanceId" | "nativeIssueId">): Promise<boolean> {
  if (run.runtimeMode !== "native" || !SETTLED_RUN_STATUSES.includes(run.status) || run.processPid || run.processGroupId) return false;
  const refusedBeforeLaunch = run.status === "failed" && (run.errorCode === "native_session_cleanup_quarantined" ||
    await hasRunEvent(db, run, PRIOR_OWNER_FENCE_REFUSED));
  if (!refusedBeforeLaunch) {
    // A coordinator row requires the run's native issue (foreign key), so the
    // native issue also rules out a coordinator.
    if (run.nativeSessionId || run.runnerInstanceId || run.nativeIssueId) return false;
  }
  const [launch] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED])),
  )).limit(1);
  return !launch;
}

/** A native run the cleanup gate refused before it asked for a runner. Its
 * process fields may name its predecessor's process, copied at admission for
 * the same session; that process is checked separately. This run launched
 * nothing of its own. */
export async function nativeGatedRunNeverLaunched(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "runtimeMode" | "status" | "errorCode">): Promise<boolean> {
  if (run.runtimeMode !== "native" || run.status !== "failed" || run.errorCode !== "native_session_cleanup_quarantined") return false;
  const [launch] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED])),
  )).limit(1);
  return !launch;
}

/** Pre-receipt native runs can retain an exact suspended session after their
 * mutable process fields were cleared. This is admission evidence for a new
 * user turn only, never permission to replay the old run or infer its outcomes.
 * The caller must hold the run/controller locks and verify local lease cleanup.
 */
export async function hasHistoricalSuspendedNativeSession(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "runtimeMode" | "processPid" | "processGroupId" |
  "nativeSessionId" | "runnerInstanceId" | "nativeIssueId" | "runnerProfileJson">) {
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
export async function readUnidentifiedLocalRunnerStop(db: Db, companyId: string, runId: string): Promise<boolean> {
  const [latest, launch] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, LOCAL_PROCESS_STOPPED])))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(2);
  if (latest?.eventType !== LOCAL_PROCESS_STOPPED || latest.payload?.basis !== "unidentified_runner_absent" ||
      launch?.eventType !== PROCESS_START_REQUESTED || launch.payload?.hostname !== os.hostname()) return false;
  const { noLocalRunnerProcessForRun } = await import("./native-runtime/native-session-executor.js");
  return noLocalRunnerProcessForRun(runId);
}

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
export type SettledProcessReleaseResult = { outcome: SettledProcessRelease; remoteStop: boolean };

const providerEventTypes = () => sql.join(NATIVE_SESSION_PROVIDER_EVENT_TYPES.map(type => sql`${type}`), sql`, `);

function settledNativeProcessReleaseCondition() {
  const processSpace = currentProcessSpaceHash();
  const ownSpace = processSpace === UNKNOWN_PROCESS_SPACE ? undefined : eq(heartbeatRuns.processHostHash, processSpace);
  const remoteLease = sql`exists (select 1 from environment_leases settled_lease where settled_lease.company_id = ${heartbeatRuns.companyId}
    and settled_lease.heartbeat_run_id = ${heartbeatRuns.id} and settled_lease.provider is distinct from 'local')`;
  const unrecordedSpace = or(isNull(heartbeatRuns.processHostHash), eq(heartbeatRuns.processHostHash, UNKNOWN_PROCESS_SPACE));
  return and(eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, SETTLED_RUN_STATUSES),
    isNotNull(heartbeatRuns.finishedAt),
    or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), isNotNull(heartbeatRuns.processStartedAt)),
    or(ownSpace, eq(heartbeatRuns.processHostHash, "remote"), isNull(heartbeatRuns.processHostHash),
      eq(heartbeatRuns.processHostHash, UNKNOWN_PROCESS_SPACE)),
    or(ownSpace, remoteLease, and(unrecordedSpace, sql`(select settled_identity.payload->>'hostname' from heartbeat_run_events settled_identity
      where settled_identity.company_id = ${heartbeatRuns.companyId} and settled_identity.run_id = ${heartbeatRuns.id}
        and settled_identity.event_type = ${PROCESS_IDENTITY_RECORDED} and settled_identity.source_event_id is null
      order by settled_identity.seq desc limit 1) = ${os.hostname()}::text`)),
    sql`not exists (select 1 from native_run_finalizations settled_coordinator
      where settled_coordinator.run_id = ${heartbeatRuns.id} and settled_coordinator.phase not in ('committed', 'terminal_failure'))`,
    sql`(coalesce(${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint', 'null'::jsonb) <> 'null'::jsonb
      or exists (select 1 from heartbeat_run_events settled_evidence where settled_evidence.company_id = ${heartbeatRuns.companyId}
        and settled_evidence.run_id = ${heartbeatRuns.id} and settled_evidence.event_type in (${providerEventTypes()})))`);
}

export async function settledNativeProcessCandidates(db: Pick<Db, "execute">, input: {
  companyId?: string; runId?: string; after?: string | null; limit: number;
}): Promise<Array<{ id: string; companyId: string }>> {
  const processSpace = currentProcessSpaceHash();
  const condition = and(input.companyId ? eq(heartbeatRuns.companyId, input.companyId) : undefined,
    input.runId ? eq(heartbeatRuns.id, input.runId) : undefined, input.after ? gt(heartbeatRuns.id, input.after) : undefined,
    settledNativeProcessReleaseCondition());
  const spaces = [processSpace === UNKNOWN_PROCESS_SPACE ? null : eq(heartbeatRuns.processHostHash, processSpace),
    eq(heartbeatRuns.processHostHash, "remote"), eq(heartbeatRuns.processHostHash, UNKNOWN_PROCESS_SPACE),
    isNull(heartbeatRuns.processHostHash)].filter(space => space !== null);
  const branches = spaces.map(space => sql`(select ${heartbeatRuns.id} as id, ${heartbeatRuns.companyId} as company_id
    from ${heartbeatRuns} where ${and(space, condition)} offset 0)`);
  return await db.execute(sql`select id, company_id as "companyId" from (${sql.join(branches, sql` union all `)}) candidates
    order by id limit ${input.limit}`) as unknown as Array<{ id: string; companyId: string }>;
}

type SettledProcessFacts = {
  companyId: string; agentId: string; runtimeMode: string; status: string; finished: boolean;
  processPid: number | null; processGroupId: number | null; processStartedAt: string | null; apiDriver: boolean | null;
  hasSessionCheckpoint: boolean; phase: string | null; providerEvidence: boolean; remoteLeases: boolean;
  localLeasePending: boolean; identityMatches: boolean | null;
};

function readSettledProcessFacts(tx: Db, runId: string) {
  return tx.execute(sql`select r.company_id as "companyId", r.agent_id as "agentId", r.runtime_mode as "runtimeMode",
      r.status, r.finished_at is not null as "finished", r.process_pid as "processPid", r.process_group_id as "processGroupId",
      to_char(r.process_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "processStartedAt",
      r.driver_kind = 'cursor_cloud_api' as "apiDriver",
      coalesce(r.runner_profile_json->'sessionCheckpoint', 'null'::jsonb) <> 'null'::jsonb as "hasSessionCheckpoint",
      (select f.phase from native_run_finalizations f where f.run_id = r.id limit 1) as "phase",
      exists (select 1 from heartbeat_run_events e where e.company_id = r.company_id and e.run_id = r.id
        and e.event_type in (${providerEventTypes()})) as "providerEvidence",
      exists (select 1 from environment_leases l where l.company_id = r.company_id and l.heartbeat_run_id = r.id
        and l.provider is distinct from 'local') as "remoteLeases",
      exists (select 1 from environment_leases l where l.company_id = r.company_id and l.heartbeat_run_id = r.id
        and (l.released_at is null or l.status = 'pending_cleanup' or l.cleanup_status = 'failed')) as "localLeasePending",
      (select identity.payload->>'targetKind' = 'local' and identity.payload->>'hostname' = ${os.hostname()}::text
          and identity.payload ? 'processPid' and identity.payload->'processPid' = coalesce(to_jsonb(r.process_pid), 'null'::jsonb)
          and identity.payload ? 'processGroupId' and identity.payload->'processGroupId' = coalesce(to_jsonb(r.process_group_id), 'null'::jsonb)
          and case when r.process_started_at is not null
            then identity.payload->>'processStartedAt' = to_char(r.process_started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            else coalesce(r.process_pid > 1 and r.process_group_id = r.process_pid, false) end
        from (select e.payload from heartbeat_run_events e where e.company_id = r.company_id and e.run_id = r.id
          and e.event_type = ${PROCESS_IDENTITY_RECORDED}::text and e.source_event_id is null order by e.seq desc limit 1) identity
      ) as "identityMatches"
    from heartbeat_runs r where r.id = ${runId}::uuid for update of r`) as unknown as Promise<SettledProcessFacts[]>;
}

export async function releaseSettledNativeRunProcess(db: Db, runId: string, options: { onDeferredDeadline?: (at: number) => void } = {}): Promise<SettledProcessRelease> {
  return (await inspectSettledNativeRunProcess(db, runId, options)).outcome;
}

export async function inspectSettledNativeRunProcess(db: Db, runId: string, options: { onDeferredDeadline?: (at: number) => void } = {}): Promise<SettledProcessReleaseResult> {
  let remoteStop = false;
  const outcome = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await readSettledProcessFacts(tx, runId);
    if (!run) return "skipped";
    remoteStop = run.remoteLeases || (run.status === "cancelled" && run.apiDriver === true);
    if (run.runtimeMode !== "native" || !SETTLED_RUN_STATUSES.includes(run.status) || !run.finished ||
        (run.processPid === null && run.processGroupId === null && run.processStartedAt === null)) return "skipped";
    if (run.phase !== null && !SETTLED_COORDINATOR_PHASES.includes(run.phase)) return "skipped";
    if (!run.hasSessionCheckpoint && !run.providerEvidence) return "skipped";
    if (run.remoteLeases) {
      const leases = await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, runId),
      ));
      if (!leases.every(hasRemoteTerminationReceipt)) return "pending";
    } else {
      if (run.localLeasePending) return "pending";
      if (run.identityMatches !== true) return "skipped";
      if ((!run.processPid && !run.processGroupId) || (run.processPid && !absent(run.processPid))
          || (run.processGroupId && !absent(-run.processGroupId))) {
        options.onDeferredDeadline?.(Date.now() + 30_000);
        return "pending";
      }
      await appendLocalProcessStop(tx, { id: runId, companyId: run.companyId, agentId: run.agentId,
        processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt });
    }
    await notifyLiveRunRecovery(tx, { companyId: run.companyId, runId, agentId: run.agentId });
    await notifyRetainedNativeSessionCleanup(tx, { companyId: run.companyId, runId });
    // Local and remote stops both close the run's usage source.
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, run.companyId);
    await tx.update(heartbeatRuns).set({
      processPid: null, processGroupId: null, processStartedAt: null, updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, runId));
    return "released" as const;
  });
  if (outcome !== "pending") pendingSettledProcessReleases.delete(runId);
  return { outcome, remoteStop };
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
    const candidates: Array<{ id: string }> = await settledNativeProcessCandidates(db, { after, limit });
    for (const candidate of candidates) {
      if (input.skip?.(candidate.id)) continue;
      if (await settleNativeRunProcess(db, candidate.id) === "released") released += 1;
    }
    after = candidates.length < limit ? null : candidates.at(-1)!.id;
  } while (after);
  return { released };
}
