import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { REMOTE_WORKSPACE_PREPARATION_TIMEOUT_CODE } from "./remote-workspace-transport.js";
import { WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS } from "../modules/run-dispatch/index.js";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

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
  const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
    eq(environmentLeases.heartbeatRunId, authority.writerRunId)));
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
