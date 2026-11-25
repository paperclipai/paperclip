import { and, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations,
  workspaceOperations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "./remote-execution-termination.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "./remote-workspace-epoch-abandonment.js";
import { REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE } from "./remote-workspace-transport.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { notifyTerminalWorkspaceWork } from "./terminal-workspace-work.js";
import { wakeWorkspaceBusyWaitersInTx, WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS } from "../modules/run-dispatch/index.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type WriterHoldTx = Db | Transaction;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_RUN_STATUSES = ["failed", "cancelled", "interrupted", "timed_out", "succeeded"];
const ACTIVE_SYSTEM_RECOVERY_STATES = ["scheduled", "running", "awaiting_evidence"];
const ACTIVE_CONTINUATION_DELIVERIES = ["pending", "delivered", "delegated"];

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = (value: unknown): string | null => typeof value === "string" && UUID_RE.test(value) ? value : null;

type RecoveryActionRow = { status: string; evidence: Record<string, unknown> };

function hasBlockingUnsafeArchiveHold(action: RecoveryActionRow, writerId: string): boolean {
  if (action.evidence.workspaceRestoreFailure !== "restore_unsafe_archive") return false;
  return explicitContinuationSuccessorId(action, writerId) === null
    && reconciliationSuccessorId(action, writerId) === null;
}

function explicitContinuationSuccessorId(action: RecoveryActionRow, writerId: string): string | null {
  const explicit = object(action.evidence.explicitUserContinuation);
  const runId = uuid(explicit.runId);
  return explicit.previousRunId === writerId && runId && runId !== writerId ? runId : null;
}

function reconciliationSuccessorId(action: RecoveryActionRow, writerId: string): string | null {
  if (!action.evidence.executionReconciliation) return null;
  if (!ACTIVE_CONTINUATION_DELIVERIES.includes(String(action.evidence.continuationDelivery))) return null;
  const runId = uuid(action.evidence.continuationRunId);
  return runId && runId !== writerId ? runId : null;
}

function writerHasBlockingHold(actions: RecoveryActionRow[], writerId: string): boolean {
  return actions.some(action => {
    if (["active", "escalated"].includes(action.status)) return true;
    const systemRecovery = readSystemRecovery(action.evidence);
    if (systemRecovery && ACTIVE_SYSTEM_RECOVERY_STATES.includes(systemRecovery.state)) return true;
    if (object(action.evidence.automaticRecovery).replay === "blocked") return true;
    return hasBlockingUnsafeArchiveHold(action, writerId);
  });
}

function collectDurableSuccessorIds(
  writerId: string,
  coordinatorFailureDetail: Record<string, unknown> | null | undefined,
  actions: RecoveryActionRow[],
): string[] {
  const ids = new Set<string>();
  const coordinatorSuccessor = uuid(object(coordinatorFailureDetail).successorRunId);
  if (coordinatorSuccessor && coordinatorSuccessor !== writerId) ids.add(coordinatorSuccessor);
  for (const action of actions) {
    if (action.status !== "resolved") continue;
    const explicit = explicitContinuationSuccessorId(action, writerId);
    if (explicit) ids.add(explicit);
    const reconciled = reconciliationSuccessorId(action, writerId);
    if (reconciled) ids.add(reconciled);
  }
  return [...ids];
}

export type RemoteWorkspaceWriter = {
  runId: string; agentId: string; issueId: string; issueIdentifier: string | null; lastActivityAt: Date;
  /** The writer run ended; its workspace save or sandbox release has not settled. */
  ended?: boolean;
  ownerFenceHeld?: boolean;
};

export function runOwnerFenceHeldSql() {
  return sql<boolean>`(coalesce(${heartbeatRuns.controllerLeaseExpiresAt} > now(), false) or exists (
    select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
      and ${nativeRunFinalizations.leaseOwner} is not null and ${nativeRunFinalizations.leaseExpiresAt} > now()))`;
}

/** The setup error a run gets when reservation refuses a remote workspace hold. */
export const REMOTE_WORKSPACE_WRITER_PENDING_MESSAGE = "The workspace still has an unfinished writer or save operation.";

type RemoteWorkspaceWriterHold = Awaited<ReturnType<typeof readRemoteWorkspaceWriterHold>>;

/**
 * Whether a hold refuses a new run outright instead of parking it in a
 * workspace wait: a writer that cannot be named, or one silent past the holder
 * cutoff with no live owner fence. Workspace reservation fails setup on such a
 * hold, so senders of automatic wakes read this same rule to hold a wake until
 * the hold settles rather than create a run that can only fail.
 */
export function remoteWorkspaceHoldRefusesStart(hold: RemoteWorkspaceWriterHold, now = Date.now()): boolean {
  if (hold.kind === "unattributed") return true;
  if (hold.kind !== "held") return false;
  return !hold.writer.ownerFenceHeld && hold.writer.lastActivityAt.getTime() < now - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS;
}

/**
 * Who still holds a remote workspace through its recorded writer run, other
 * than `runId`. A running writer holds it. An ended writer keeps holding it
 * until its save and sandbox release settle. `unattributed` is a hold whose
 * writer cannot be named (no run or task); `free` means another run may
 * become the writer. Workspace reservation and the parked workspace wait read
 * this one rule, so a wait never ends before reservation would succeed.
 */
export async function readRemoteWorkspaceWriterHold(tx: Db, input: {
  companyId: string; authority: RemoteWorkspaceAuthority; runId?: string | null;
}): Promise<{ kind: "free" } | { kind: "unattributed" } | { kind: "held"; writer: RemoteWorkspaceWriter }> {
  const { authority, companyId } = input;
  if (!authority.writerRunId || authority.writerRunId === input.runId) return { kind: "free" };
  const [prior] = await tx.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    runtimeMode: heartbeatRuns.runtimeMode, nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
    errorCode: heartbeatRuns.errorCode, executionRecovery: sql<unknown>`${heartbeatRuns.resultJson}->'executionRecovery'`,
    contextIssueId: sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
    lastOutputAt: heartbeatRuns.lastOutputAt, startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt,
    finishedAt: heartbeatRuns.finishedAt, ownerFenceHeld: runOwnerFenceHeldSql(),
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, authority.writerRunId)));
  const writerIssueId = prior ? prior.nativeIssueId ?? prior.issueId ?? prior.contextIssueId : null;
  const [writerIssue] = writerIssueId ? await tx.select({ id: issues.id, identifier: issues.identifier }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, canonicalExecutionUuid(sql`${writerIssueId}::text`)))) : [];
  if (prior?.status === "running" && writerIssue) return { kind: "held", writer: {
    runId: authority.writerRunId, agentId: prior.agentId, issueId: writerIssue.id, issueIdentifier: writerIssue.identifier,
    lastActivityAt: prior.lastOutputAt ?? prior.startedAt ?? prior.createdAt, ownerFenceHeld: prior.ownerFenceHeld === true,
  } };
  const rawLeases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
    eq(environmentLeases.heartbeatRunId, authority.writerRunId)));
  const leases = await Promise.all(rawLeases.map(lease => resolveRemoteTerminationLease(tx, lease)));
  const bootstrap = object(prior?.executionRecovery);
  const pristinePreparation = !authority.location && !authority.snapshotId && prior?.status === "failed"
    && prior.runtimeMode === "legacy" && prior.nativeSessionId === null && prior.runnerInstanceId === null
    && prior.errorCode === REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE
    && bootstrap.kind === "bootstrap" && bootstrap.providerWorkStarted === false;
  const unusedReservation = !authority.dirty && prior && ["failed", "cancelled", "interrupted", "timed_out", "succeeded"].includes(prior.status)
    && leases.every(lease => hasRemoteTerminationReceipt(lease) || hasRecoveredCleanupStopReceipt(lease) || (pristinePreparation
      && lease.releasedAt && lease.cleanupStatus === "success" && ["released", "expired", "failed"].includes(lease.status)));
  if (unusedReservation) return { kind: "free" };
  // An ended writer still holds the workspace until its save and sandbox
  // release settle, within the same bounded cutoff as a live writer. While
  // Paperclip is still saving the writer's retained files, that save's last
  // progress is the writer's activity, so a waiter keeps waiting instead of
  // failing setup. The save's own retry budget bounds it; a completed or
  // board-handed-off save no longer extends the cutoff.
  if (prior && writerIssue) {
    const ended = new Date(prior.finishedAt ?? prior.lastOutputAt ?? prior.startedAt ?? prior.createdAt);
    const [save] = await tx.select({ progressedAt: sql<string | null>`max(${issueRecoveryActions.updatedAt})` })
      .from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, writerIssue.id),
        sql`${issueRecoveryActions.evidence}->>'runId' = ${authority.writerRunId}`,
        sql`${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'`,
        sql`coalesce(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}', 'scheduled') in ('scheduled', 'running', 'awaiting_evidence')`,
        sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' is distinct from 'recovered'`));
    const saving = save?.progressedAt ? new Date(save.progressedAt) : null;
    return { kind: "held", writer: {
      runId: authority.writerRunId, agentId: prior.agentId, issueId: writerIssue.id, issueIdentifier: writerIssue.identifier,
      lastActivityAt: saving && saving.getTime() > ended.getTime() ? saving : ended, ended: true,
    } };
  }
  return { kind: "unattributed" };
}

/**
 * Abandons a dirty remote workspace epoch whose ended writer was already
 * superseded by a recorded successor run, once that successor has also ended
 * (or is itself reserving the workspace). Preserves every unsaved-files
 * invariant: never touches a writer with an uncommitted accepted result, an
 * open or active recovery hold, an unsettled no-replay hold, a running save,
 * or a live controller/finalizer fence. Uses `abandonUnverifiedRemoteWorkspaceEpoch`
 * so the old writer is fenced, its unverified root is retained unapplied, and
 * the next writer restores the last committed snapshot into a new directory.
 * The caller holds the workspace row lock.
 */
export async function releaseSupersededRemoteWorkspaceWriter(tx: WriterHoldTx, input: {
  workspace: typeof executionWorkspaces.$inferSelect;
  authority: RemoteWorkspaceAuthority;
  callerRunId?: string | null;
  wakeWaiters?: boolean;
}): Promise<{ workspace: typeof executionWorkspaces.$inferSelect; authority: RemoteWorkspaceAuthority } | null> {
  const { workspace, authority } = input;
  const runId = authority.writerRunId;
  if (!runId || !authority.dirty || !authority.location || runId === input.callerRunId) return null;
  const db = tx as Db;
  const now = new Date();
  // Never wait on a writer run another transaction holds; that owner settles it.
  const [writer] = await db.select({
    id: heartbeatRuns.id, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
    runnerProfileJson: heartbeatRuns.runnerProfileJson,
    contextIssueId: sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, runId)))
    .for("update", { skipLocked: true });
  if (!writer || !TERMINAL_RUN_STATUSES.includes(writer.status) || !writer.finishedAt
    || adapterExecutionControls.has(writer.id)
    || (writer.controllerLeaseExpiresAt && writer.controllerLeaseExpiresAt > now)) return null;
  const remoteProfile = writer.runnerProfileJson?.remoteWorkspace;
  if (remoteProfile !== undefined && remoteProfile !== null) {
    const parsed = remoteWorkspaceRunReferenceSchema.safeParse(remoteProfile);
    if (!parsed.success || parsed.data.state !== "prepared"
      || parsed.data.workspaceId !== workspace.id || parsed.data.epoch !== authority.epoch) return null;
  }
  const [saving] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, workspace.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.phase, "remote_workspace_snapshot"), inArray(workspaceOperations.status, ["running", "pending"]),
    sql`${workspaceOperations.metadata}->>'epoch' = ${String(authority.epoch)}`)).limit(1);
  if (saving) return null;
  const [coordinator] = await db.select({
    phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId,
    leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
    failureDetail: nativeRunFinalizations.failureDetail,
  }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, workspace.companyId), eq(nativeRunFinalizations.runId, writer.id)));
  if (coordinator?.leaseOwner && (!coordinator.leaseExpiresAt || coordinator.leaseExpiresAt > now)) return null;
  // An uncommitted accepted result still owes its unsaved files to export recovery.
  if (coordinator?.resultId && coordinator.phase !== "committed") return null;

  const writerIssueId = uuid(writer.nativeIssueId ?? writer.issueId ?? writer.contextIssueId);
  if (!writerIssueId) return null;
  const actions = await db.select({
    status: issueRecoveryActions.status, evidence: issueRecoveryActions.evidence,
  }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, workspace.companyId), eq(issueRecoveryActions.sourceIssueId, writerIssueId),
    or(sql`${issueRecoveryActions.evidence}->>'runId' = ${writer.id}`,
      sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${writer.id}`)));
  if (writerHasBlockingHold(actions, writer.id)) return null;

  const successorIds = collectDurableSuccessorIds(writer.id, coordinator?.failureDetail, actions);
  if (successorIds.length === 0) return null;

  const successorRows = await db.select({
    id: heartbeatRuns.id, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, workspace.companyId), inArray(heartbeatRuns.id, successorIds)));
  const successorsById = new Map(successorRows.map(row => [row.id, row]));
  for (const successorId of successorIds) {
    if (successorId === input.callerRunId) continue;
    const successor = successorsById.get(successorId);
    if (!successor || !TERMINAL_RUN_STATUSES.includes(successor.status) || !successor.finishedAt
      || adapterExecutionControls.has(successor.id)
      || (successor.controllerLeaseExpiresAt && successor.controllerLeaseExpiresAt > now)) return null;
  }

  // Register terminal-workspace work intent BEFORE modifying the workspace row
  // (rules/sleep-aware-background-work.mdc).
  await notifyTerminalWorkspaceWork(db, `workspace:${workspace.id}`);
  let abandoned: Awaited<ReturnType<typeof abandonUnverifiedRemoteWorkspaceEpoch>>;
  try {
    abandoned = await abandonUnverifiedRemoteWorkspaceEpoch(tx as Transaction, {
      companyId: workspace.companyId, workspaceId: workspace.id, runId: writer.id,
      epoch: authority.epoch, snapshotId: authority.snapshotId, location: authority.location,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "remote_workspace_authority_changed") return null;
    throw error;
  }
  if (input.wakeWaiters !== false) {
    await wakeWorkspaceBusyWaitersInTx(db, {
      companyId: workspace.companyId, runId: writer.id, contextSnapshot: null, scheduledRetryReason: null, now,
    });
  }
  return abandoned;
}
