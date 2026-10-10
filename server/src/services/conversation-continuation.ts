import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

// These adapters accept a conversation turn. Retrying a process or webhook can
// replay the action itself, so those adapters retain their recovery contract.
export const CONVERSATION_ADAPTER_TYPES = [
  "claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
  "pi_local", "grok_local", "kimi_local", "hermes_local",
] as const;

export function isConversationAdapter(adapterType: string): boolean {
  return (CONVERSATION_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export const CONVERSATION_CONTINUATION_POLICY = "continue_conversation_v1";

/** A live PID whose start time cannot be read is indistinguishable from a
 * recycled PID. Holding execution authority on that ambiguity is unbounded: the
 * candidate run is already terminal, so the hold outlives the work and blocks
 * both admission and wake-queue drain for the issue until whatever unrelated
 * process now owns the PID happens to exit. The grace is measured from the moment
 * the run reached its terminal state, because a process that outlives its own
 * terminal run by this long is not plausibly still executing that run's work. */
export const UNVERIFIED_PROCESS_IDENTITY_GRACE_MS = 6 * 60 * 60_000;

export function hasConversationContinuationPolicy(result: Record<string, unknown> | null | undefined): boolean {
  return result?.workspaceRestoreFailure !== "restore_unsafe_archive" && !hasRequiredWorkspaceRecovery(result) && result?.conversationContinuation === CONVERSATION_CONTINUATION_POLICY;
}

/** Persisted by the server when it claims the run, before remote provisioning. */
export function claimedAdapterType(run: Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">): string | null {
  const dispatch = run.runnerProfileJson?.adapterDispatch as Record<string, unknown> | undefined;
  return typeof dispatch?.adapterType === "string" ? dispatch.adapterType : null;
}

function conversationRunPredicate() {
  return or(
    inArray(sql`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES]),
    sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
    sql`exists (
      select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
        and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and ${heartbeatRunEvents.eventType} = 'adapter.invoke'
        and ${inArray(sql`${heartbeatRunEvents.payload}->>'adapterType'`, [...CONVERSATION_ADAPTER_TYPES])}
    )`,
  );
}

/** Recovery must not infer the old adapter from the agent's mutable settings. */
export async function historicalAdapterType(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<string | null> {
  const selected = claimedAdapterType(run);
  if (selected) return selected;
  const [invocation] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke")))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const adapterType = invocation?.payload?.adapterType;
  return typeof adapterType === "string" ? adapterType : null;
}

export async function runUsedConversationAdapter(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive" || hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  if (hasConversationContinuationPolicy(run.resultJson)) return true;
  const adapterType = await historicalAdapterType(db, run);
  return adapterType !== null && isConversationAdapter(adapterType);
}

/** Only immutable run evidence can retire a historical conversation hold.
 * An agent's current adapter can differ from the one that executed this run.
 * Missing evidence retains the hold; the current agent is never a fallback.
 */
export function conversationRecoveryActionPredicate() {
  return and(
    eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation"),
    sql`exists (
      select 1 from ${heartbeatRuns}
      where ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        and ${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'
        and coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueRecoveryActions.sourceIssueId}::text
        and ${heartbeatRuns.runtimeMode} = 'legacy'
        and coalesce(${heartbeatRuns.resultJson}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
        and coalesce(${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema', '') <> 'paperclip.workspace-restore-recovery.v1'
        and ${inArray(heartbeatRuns.status, ['failed', 'timed_out', 'interrupted', 'cancelled'])}
        and ${conversationRunPredicate()}
        and ${or(
          sql`${heartbeatRuns.resultJson}->>'conversationContinuation' = ${CONVERSATION_CONTINUATION_POLICY}`,
          eq(heartbeatRuns.status, "interrupted"),
          inArray(heartbeatRuns.errorCode, ["process_lost", "server_shutdown_interrupted", "execution_reconciliation_required"]),
          and(eq(heartbeatRuns.status, "cancelled"), sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'acknowledged'`),
        )}
    )`,
  );
}

/** OS liveness probes do not signal or stop the process. Unknown ownership holds. */
function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A terminal conversation row does not prove that its execution authority ended.
 * Other adapters keep their existing bootstrap and ownership protocols.
 */
export async function getConversationOwnershipBlocker(
  db: Db,
  companyId: string,
  issueId: string,
  options: {
    isProcessAlive?: (pid: number) => boolean;
    readProcessStartedAt?: (pid: number) => Promise<string | null>;
    now?: () => number;
  } = {},
) {
  const isAlive = options.isProcessAlive ?? processMayBeAlive;
  const readStartedAt = options.readProcessStartedAt ?? readProcessStartedAt;
  const now = options.now ?? Date.now;
  // A lease in pending_cleanup (or with a failed cleanup) is work the runtime
  // still owes: destroy that environment before the issue continues. The
  // pending-cleanup sweep retries and caps those, so this hold tracks real
  // cleanup intent and stays unconditional.
  const cleanupPendingLease = sql`exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and (${environmentLeases.status} = 'pending_cleanup'
        or ${environmentLeases.cleanupStatus} = 'failed'))`;
  // A lease that is merely unreleased (`released_at is null`, no cleanup pending)
  // means its terminal run never finished its release. Nothing reclaims that row,
  // so an unconditional hold wedges the issue forever: every later wake reads the
  // same stale lease and defers. Bound it by the same terminal-age grace as an
  // unverifiable PID, because a lease that outlives its own terminal run by that
  // long is not plausibly still executing that run's work.
  const unreleasedLease = sql`exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and ${environmentLeases.releasedAt} is null
      and ${environmentLeases.status} <> 'pending_cleanup'
      and coalesce(${environmentLeases.cleanupStatus}, '') <> 'failed')`;
  const candidates = await db.select({ run: heartbeatRuns, cleanupPendingLease, unreleasedLease }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), cleanupPendingLease, unreleasedLease,
        sql`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'`),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, cleanupPendingLease: cleanupPending, unreleasedLease: leaseUnreleased } of candidates) {
    if (hasRequiredWorkspaceRecovery(run.resultJson)) {
      const leases = await db.select().from(environmentLeases).where(and(
        eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, run.id),
      ));
      const retainedIds = (run.resultJson!.workspaceRestoreRecovery as { leaseIds?: unknown }).leaseIds;
      const remoteLeases = leases.filter(lease => lease.provider !== "local");
      const remoteStopped = Array.isArray(retainedIds) && retainedIds.length > 0
        && retainedIds.every(id => typeof id === "string" && remoteLeases.some(lease =>
          lease.id === id && hasRemoteTerminationReceipt(lease)))
        && remoteLeases.every(hasRemoteTerminationReceipt);
      if (!remoteStopped) return {
        runId: run.id, agentId: run.agentId, cause: "execution_owner_active",
        nextAction: "The retained workspace environment has not confirmed that it stopped. Wait for cleanup before continuing this task.",
      };
      // These PIDs came from the sandbox. A matching process on this host is
      // unrelated and must not hide the repair action or block a repaired task.
      // A separate local lease keeps the existing host process checks below.
      if (leases.every(lease => lease.provider !== "local")) continue;
    }
    // The run is already terminal; every hold below is bounded by how long it has
    // been terminal, never by how old the run itself is.
    const terminalAt = run.finishedAt ?? run.updatedAt ?? run.createdAt;
    const terminalAgeMs = now() - new Date(terminalAt).getTime();
    const pastTerminalGrace = Number.isFinite(terminalAgeMs) && terminalAgeMs > UNVERIFIED_PROCESS_IDENTITY_GRACE_MS;
    let pidAlive = run.processPid !== null && isAlive(run.processPid);
    let identityUnverified = false;
    if (pidAlive && run.processStartedAt) {
      // A recycled PID cannot keep an old task blocked.
      const observed = await readStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        pidAlive = false;
      } else if (!observed) {
        // An unreadable identity stays conservative, but only for a bounded
        // grace: the run is already terminal, so past the grace the ambiguity
        // resolves toward release instead of wedging the issue forever.
        if (pastTerminalGrace) {
          console.warn(
            `[conversation-continuation] releasing unverifiable execution hold on run ${run.id}: `
            + `PID ${run.processPid} is alive but its start time could not be read, and the run has been `
            + `terminal for ${Math.round(terminalAgeMs / 60_000)} minutes`,
          );
          pidAlive = false;
        } else {
          identityUnverified = true;
        }
      }
    }
    const groupAlive = run.processGroupId !== null && isAlive(-run.processGroupId);
    let leaseHeld = cleanupPending;
    if (!leaseHeld && leaseUnreleased) {
      if (pastTerminalGrace) {
        console.warn(
          `[conversation-continuation] releasing unreleased environment lease hold on run ${run.id}: `
          + `the terminal run's lease was never released and the run has been `
          + `terminal for ${Math.round(terminalAgeMs / 60_000)} minutes`,
        );
      } else {
        leaseHeld = true;
      }
    }
    if (pidAlive || groupAlive || leaseHeld) {
      const heldByProcess = pidAlive || groupAlive;
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "execution_owner_active",
        nextAction: heldByProcess
          ? (identityUnverified
            ? "The previous provider process is still running and its start time could not be read, so a recycled process id cannot be ruled out yet. Stop it before continuing this task."
            : "The previous provider process is still running. Stop it before continuing this task.")
          : "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
        ...(identityUnverified ? { identityUnverified: true } : {}),
      };
    }
  }
  return null;
}