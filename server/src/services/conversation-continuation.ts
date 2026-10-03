import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";

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
  return result?.workspaceRestoreFailure !== "restore_unsafe_archive" && result?.conversationContinuation === CONVERSATION_CONTINUATION_POLICY;
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
  if (run.resultJson?.workspaceRestoreFailure === "restore_unsafe_archive") return false;
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

const execFileAsync = promisify(execFile);

async function processGroupMembers(groupId: number): Promise<Array<{ pid: number; startedAt: string }> | null> {
  if (process.platform === "win32") return null;
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,lstart="], { timeout: 1_500 });
  const members: Array<{ pid: number; startedAt: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== groupId) continue;
    const startedAt = new Date(match[3]).toISOString();
    members.push({ pid: Number(match[1]), startedAt });
  }
  return members.length ? members : null;
}

export async function persistedConversationProcessLiveness(
  run: { processPid: number | null; processGroupId: number | null; processStartedAt: Date | null; finishedAt?: Date | null },
  probes: { isAlive: (pid: number) => boolean; startedAt: (pid: number) => Promise<string | null>;
    groupMembers?: (groupId: number) => Promise<Array<{ pid: number; startedAt: string }> | null> } = {
    isAlive: processMayBeAlive,
    startedAt: readProcessStartedAt,
    groupMembers: processGroupMembers,
  },
): Promise<{ pidAlive: boolean; groupAlive: boolean }> {
  let pidAlive = run.processPid !== null && probes.isAlive(run.processPid);
  let pidReused = false;
  if (pidAlive && run.processStartedAt) {
    // A reused PID does not prove that its old process group has ended: a
    // descendant may still be running in it. Keep the independent group probe.
    const observed = await probes.startedAt(run.processPid!).catch(() => null);
    // ps reports whole seconds and a spawn callback may have supplied the
    // timestamp when the first start-time read failed.
    const observedTime = observed === null ? NaN : new Date(observed).getTime();
    const startedAfterRunEnded = run.finishedAt !== null && run.finishedAt !== undefined &&
      observedTime > run.finishedAt.getTime();
    if (Number.isFinite(observedTime) &&
        (Math.abs(observedTime - run.processStartedAt.getTime()) >= 5_000 || startedAfterRunEnded)) {
      pidReused = true;
      pidAlive = false;
    }
  }
  let groupAlive = run.processGroupId !== null && probes.isAlive(-run.processGroupId);
  if (groupAlive && pidReused && run.processGroupId === run.processPid && probes.groupMembers) {
    // A new leader with no older members proves that this is a different group.
    // Missing or unreadable membership keeps the historical hold.
    const members = await probes.groupMembers(run.processGroupId!).catch(() => null);
    const leader = members?.find((member) => member.pid === run.processGroupId);
    if (leader && members!.every((member) => new Date(member.startedAt).getTime() >= new Date(leader.startedAt).getTime()))
      groupAlive = false;
  }
  return { pidAlive, groupAlive };
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
  const candidates = await db.select({ run: heartbeatRuns, activeLease }).from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.runtimeMode, "legacy"),
      conversationRunPredicate(),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      or(isNotNull(heartbeatRuns.processPid), isNotNull(heartbeatRuns.processGroupId), activeLease),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  for (const { run, activeLease: leaseHeld } of candidates) {
    const { pidAlive, groupAlive } = await persistedConversationProcessLiveness(run);
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
