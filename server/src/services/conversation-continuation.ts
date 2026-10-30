import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";

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
export async function historicalAdapterType(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "runnerProfileJson">): Promise<string | null> {
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
        and ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`)}
        and ${or(
          eq(heartbeatRuns.nativeIssueId, issueRecoveryActions.sourceIssueId),
          and(isNull(heartbeatRuns.nativeIssueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text`),
        )}
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
          // A legacy conversation turn cancelled while it still prepares never
          // reached provider dispatch, so an acknowledged stop can never be
          // recorded for it and this hold would never retire. Require positive
          // evidence instead of an absent record: the stage never advanced past
          // 'preparing', which only assertOwned("dispatching") can do and which
          // commits before the provider handoff; no process identity or session
          // was ever reserved; the controller lease has elapsed and cannot be
          // renewed, because renewal requires status 'running'; the lease was
          // claimed by a previous boot, so this boot holds no executor that
          // could still be inside an uninterruptible environment acquisition
          // and insert a lease row after the hold retires; and no retained
          // dispatch event contradicts any of it. Process liveness and lease
          // cleanup stay with getConversationOwnershipBlocker.
          and(eq(heartbeatRuns.status, "cancelled"), sql`${heartbeatRuns.runtimeMode} = 'legacy'
            and ${heartbeatRuns.executionStage} = 'preparing'
            and ${heartbeatRuns.processPid} is null
            and ${heartbeatRuns.processGroupId} is null
            and ${heartbeatRuns.processStartedAt} is null
            and ${heartbeatRuns.nativeSessionId} is null
            and ${heartbeatRuns.nativeIssueId} is null
            and ${heartbeatRuns.sessionIdAfter} is null
            and ${heartbeatRuns.controllerBootId} is not null
            and ${heartbeatRuns.controllerBootId} <> ${legacyControllerBootId}
            and ${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()
            and not exists (
              select 1 from ${heartbeatRunEvents}
              where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
                and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
                and (${heartbeatRunEvents.sourceEventId} is not null
                  or ${inArray(heartbeatRunEvents.eventType, ["adapter.invoke", PROCESS_START_REQUESTED,
                    PROCESS_IDENTITY_RECORDED, "harness.ready", "session.started", "session.resumed",
                    "session.updated", "turn.started", "provider.event", "provider.rpc_result",
                    "tool.execution.started"])})
            )`),
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
export async function getConversationOwnershipBlocker(db: Db, companyId: string, issueId: string) {
  const activeLease = sql`exists (select 1 from ${environmentLeases}
    where ${environmentLeases.companyId} = "heartbeat_runs"."company_id"
      and ${environmentLeases.heartbeatRunId} = "heartbeat_runs"."id"
      and (${environmentLeases.releasedAt} is null
        or ${environmentLeases.status} = 'pending_cleanup'
        or ${environmentLeases.cleanupStatus} = 'failed'))`;
  const candidates = await db.select({ run: {
    id: heartbeatRuns.id,
    agentId: heartbeatRuns.agentId,
    processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt,
    resultJson: heartbeatRuns.resultJson,
  }, activeLease }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      or(
        eq(heartbeatRuns.nativeIssueId, canonicalExecutionUuid(sql`${issueId}::text`)),
        and(isNull(heartbeatRuns.nativeIssueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
      ),
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), activeLease,
        sql`${heartbeatRuns.resultJson}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'`),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, activeLease: leaseHeld } of candidates) {
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
    let pidAlive = run.processPid !== null && processMayBeAlive(run.processPid);
    if (pidAlive && run.processStartedAt) {
      // A recycled PID cannot keep an old task blocked. An unreadable identity
      // stays conservative; the original process may still own execution.
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) pidAlive = false;
    }
    const groupAlive = run.processGroupId !== null && processMayBeAlive(-run.processGroupId);
    if (pidAlive || groupAlive || leaseHeld) {
      return {
        runId: run.id,
        agentId: run.agentId,
        cause: "execution_owner_active",
        nextAction: pidAlive || groupAlive
          ? "The previous provider process is still running. Stop it before continuing this task."
          : "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      };
    }
  }
  return null;
}
