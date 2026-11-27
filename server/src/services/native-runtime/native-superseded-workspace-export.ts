import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { activityLog, environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type RemoteWorkspaceRunReference } from "@paperclipai/shared";
import { SUPERSEDED_WORKSPACE_EXPORT_KEY, SUPERSEDED_WORKSPACE_EXPORT_SCHEMA } from "../workspace-recovery-fallback-discovery.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "../remote-workspace-epoch-abandonment.js";
import { notifyQueuedRunDispatch } from "../run-dispatch-notifications.js";
import { hasConfirmedSandboxStopAndRetain, hasStopOnlyCleanup, prepareUnconfirmedSourceSandboxStop,
  SANDBOX_ALLOCATION_HOLDER_STATUSES } from "../sandbox-stop-and-retain.js";
import { logActivity } from "../activity-log.js";
import { hasRequiredWorkspaceRecovery } from "../workspace-restore-recovery-state.js";

/** The finalizer's verdict for a result a newer run already decided (see native-run-finalizer). */
const SUPERSEDED = "native_finalization_superseded";
/** How long the run's own release may take to deliver its sandbox stop receipt. */
const STOP_RECEIPT_WAIT_MS = 60 * 60_000;
const STOP_RECEIPT_RECHECK_MS = 60_000;
/** While Paperclip's own stop request is pending. Its receipt also wakes this work. */
const REQUESTED_STOP_RECHECK_MS = 15 * 60_000;
/** A stop still unconfirmed this long after the run ended gets one notice on the task. */
const STOP_NOTICE_AFTER_MS = 6 * 60 * 60_000;
export const SUPERSEDED_EXPORT_STOP_NOTICE = "issue.previous_run_files_waiting";
export const SUPERSEDED_EXPORT_FILES_GONE = "issue.previous_run_files_lost";

type Coordinator = Pick<typeof nativeRunFinalizations.$inferSelect, "resultId" | "phase" | "failureCode" | "failureDetail">;

/**
 * A finalizer retired as superseded while it was exporting the run's
 * workspace. The result is never applied, but the run's files were not saved
 * either, and the run still holds its workspace as the writer.
 */
export function isSupersededWorkspaceExport(coordinator: Coordinator) {
  const detail = coordinator.failureDetail;
  return Boolean(coordinator.resultId) && coordinator.phase === "terminal_failure" && coordinator.failureCode === SUPERSEDED
    && typeof detail?.workspaceFinalizeAttempt === "number";
}

/**
 * Names the retained-file hold of a superseded export, so that a spent
 * re-export budget continues the task from its last save (the retained-source
 * fallback) instead of waiting for a person: no result waits for these files.
 */
export async function markSupersededWorkspaceExportHold(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">) {
  const marker = { schema: SUPERSEDED_WORKSPACE_EXPORT_SCHEMA, runId: run.id };
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence}
    || ${JSON.stringify({ [SUPERSEDED_WORKSPACE_EXPORT_KEY]: marker })}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, run.companyId),
      eq(issueRecoveryActions.fingerprint, `native-workspace:${run.id}`),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery' is not null`,
      sql`not (${issueRecoveryActions.evidence} ? ${SUPERSEDED_WORKSPACE_EXPORT_KEY})`));
}

/**
 * An ended run whose superseded export left its files unsaved and its
 * workspace held, with no retained-file obligation recorded yet. Rows written
 * by releases before this rule match too, so the new build settles them itself.
 */
export function supersededWorkspaceExportUnpreservedCondition() {
  return and(eq(nativeRunFinalizations.phase, "terminal_failure"), eq(nativeRunFinalizations.failureCode, SUPERSEDED),
    isNotNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.leaseOwner),
    sql`${nativeRunFinalizations.failureDetail} ? 'workspaceFinalizeAttempt'`,
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "failed"),
    sql`${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,state}' = 'prepared'`,
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync' is null`,
    sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)->'workspaceRestoreRecovery' is null`,
    sql`exists (select 1 from execution_workspaces workspace where workspace.company_id = ${heartbeatRuns.companyId}
      and workspace.id::text = ${heartbeatRuns.runnerProfileJson}#>>'{remoteWorkspace,workspaceId}'
      and workspace.metadata#>>'{remoteWorkspace,writerRunId}' = ${heartbeatRuns.id}::text
      and workspace.metadata#>>'{remoteWorkspace,dirty}' = 'true')`);
}

/**
 * Records the retained-file obligation of an ended superseded export (the
 * system workspace recovery then re-exports it from the retained sandbox).
 * The obligation needs the sandbox's stop-and-retain receipt. The run's own
 * release normally delivers it, and the receipt wakes this work again. When it
 * has not arrived within an hour of the run ending, Paperclip stops and keeps
 * the sandbox itself and waits for that receipt. The workspace stays held
 * until then: a sandbox that may still run never gets a second writer beside
 * it. When the stop cannot be requested, or stays unconfirmed for hours, the
 * task gets one notice. Returns when to check again.
 */
export async function preserveSupersededWorkspaceExport(db: Db, runId: string,
  preserve: (db: Db, run: typeof heartbeatRuns.$inferSelect) => Promise<unknown>): Promise<{ recheckAt: number | null }> {
  const [row] = await db.select({ run: heartbeatRuns }).from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .where(and(eq(nativeRunFinalizations.runId, runId), supersededWorkspaceExportUnpreservedCondition()));
  if (!row) return { recheckAt: null };
  const preserved = await preserve(db, row.run) as typeof heartbeatRuns.$inferSelect | undefined;
  if (preserved && hasRequiredWorkspaceRecovery(preserved.resultJson)) return { recheckAt: null };
  const reference = remoteWorkspaceRunReferenceSchema.safeParse(row.run.runnerProfileJson?.remoteWorkspace);
  if (!reference.success) return { recheckAt: null };
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, row.run.companyId),
    eq(environmentLeases.id, reference.data.leaseId), eq(environmentLeases.heartbeatRunId, row.run.id)));
  // A confirmed stop leaves nothing to wait for: the refusal is not about the sandbox.
  if (lease && hasConfirmedSandboxStopAndRetain(lease)) return { recheckAt: null };
  const now = Date.now(), elapsed = now - (row.run.finishedAt?.getTime() ?? 0);
  if (lease && !hasRemoteTerminationReceipt(lease) && elapsed < STOP_RECEIPT_WAIT_MS)
    return { recheckAt: now + STOP_RECEIPT_RECHECK_MS };
  if (lease && await continueFromLastSaveWhenSandboxGone(db, row.run, reference.data, lease)) return { recheckAt: null };
  const stop = lease ? await requestSourceSandboxStop(db, lease) : "unavailable";
  if (stop === "pending" && elapsed < STOP_NOTICE_AFTER_MS) return { recheckAt: now + REQUESTED_STOP_RECHECK_MS };
  await noticeOnce(db, row.run, stop);
  // Never a silent rest: the stop, another lease letting go, or a provider
  // receipt can still settle it, and each later check sees that.
  return { recheckAt: now + REQUESTED_STOP_RECHECK_MS };
}

const destroyed = (lease: typeof environmentLeases.$inferSelect) => hasRemoteTerminationReceipt(lease)
  && (lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "destroyed";

/**
 * The provider confirmed the run's sandbox is gone, so nothing can write there
 * and its unsaved files cannot be saved. Set aside only this run's workspace
 * epoch, so the task's queued runs continue from the last save, and say so on
 * the task. Every allocation of the run must carry a provider stop receipt.
 */
async function continueFromLastSaveWhenSandboxGone(db: Db, run: typeof heartbeatRuns.$inferSelect,
  reference: RemoteWorkspaceRunReference, lease: typeof environmentLeases.$inferSelect) {
  const issueId = run.nativeIssueId ?? run.issueId;
  if (!destroyed(lease) || !issueId) return false;
  return db.transaction(async tx => {
    // The existing lock order: task, run, then (in the abandonment) the workspace.
    const [task] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId),
      eq(issues.companyId, run.companyId))).for("update");
    if (!task) return false;
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId))).for("update");
    if (!current || current.status !== "failed" || !current.finishedAt
      || current.controllerLeaseExpiresAt && current.controllerLeaseExpiresAt.getTime() > Date.now()) return false;
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)));
    if (!leases.some(row => row.id === lease.id && destroyed(row))
      || leases.some(row => !hasRemoteTerminationReceipt(row) && !hasRecoveredCleanupStopReceipt(row))) return false;
    const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
    const authority = workspace ? readRemoteWorkspaceAuthority(workspace.metadata) : null;
    if (!authority?.location || authority.writerRunId !== run.id || authority.epoch !== reference.epoch
      || authority.snapshotId !== reference.snapshotId || authority.location.leaseId !== lease.id) return false;
    await abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId: run.companyId, workspaceId: reference.workspaceId,
      runId: run.id, epoch: authority.epoch, snapshotId: authority.snapshotId, location: authority.location });
    await notifyQueuedRunDispatch(tx, { companyId: run.companyId });
    await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: "system", actorId: "native-workspace-recovery",
      action: SUPERSEDED_EXPORT_FILES_GONE, entityType: "issue", entityId: issueId, agentId: run.agentId, runId: run.id,
      details: { runId: run.id, reason: "sandbox_destroyed" } });
    return true;
  });
}

type SourceStop = "pending" | "in_use" | "unavailable";

async function requestSourceSandboxStop(db: Db, lease: typeof environmentLeases.$inferSelect): Promise<SourceStop> {
  if (hasStopOnlyCleanup(lease) || lease.metadata?.pendingCleanupInFlight === true) return "pending";
  if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId || destroyed(lease)) return "unavailable";
  // A sandbox another lease holds is never stopped from here.
  const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId), inArray(environmentLeases.status, [...SANDBOX_ALLOCATION_HOLDER_STATUSES])))
    .limit(1);
  if (other) return "in_use";
  // The pending-cleanup sweep dispatches the stop and retries it until the
  // provider confirms. A lost race is re-read on the next check.
  await prepareUnconfirmedSourceSandboxStop(db, lease);
  return "pending";
}

/** One activity entry on the task, in plain words. The files are kept and
 * Paperclip keeps working on it; nothing asks a person to fix anything. */
async function noticeOnce(db: Db, run: typeof heartbeatRuns.$inferSelect, stop: SourceStop) {
  const issueId = run.nativeIssueId ?? run.issueId;
  if (!issueId) return;
  const [existing] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, run.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
    eq(activityLog.action, SUPERSEDED_EXPORT_STOP_NOTICE), eq(activityLog.runId, run.id))).limit(1);
  if (existing) return;
  await logActivity(db, { companyId: run.companyId, actorType: "system", actorId: "native-workspace-recovery",
    action: SUPERSEDED_EXPORT_STOP_NOTICE, entityType: "issue", entityId: issueId, agentId: run.agentId, runId: run.id,
    details: { runId: run.id, reason: stop === "pending" ? "stop_unconfirmed" : stop === "in_use" ? "sandbox_in_use" : "sandbox_unavailable" } });
}
