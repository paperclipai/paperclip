import { effectiveAiConnectionInput } from "@paperclipai/shared";
import { NATIVE_POOL_FAILURE_CODES, nativePoolFailureKind } from "./native-pool-failure.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";
import { notifyUnsafeWorkspaceExportRecovery } from "../unsafe-workspace-export-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { logger } from "../../middleware/logger.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { stat } from "node:fs/promises";
import { and, asc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  aiConnectionPools,
  environmentLeases,
  executionWorkspaces,
  executionWorkspaceSnapshots,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueRecoveryActions,
  nativeRunFinalizations,
  toolInvocations,
  workspaceOperations,
  type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { decideNativeReplacement } from "./native-replacement-evidence.js";
import { issueService } from "../issues.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { aiConnectionRouterService } from "../ai-connection-router.js";
import type { AiConnectionRouterSelection } from "@paperclipai/shared";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-retired-backup-source.js";
import { completedWorkspaceRecoveryCondition } from "../workspace-recovery-receipt.js";

export const NATIVE_SAFE_REPLACEMENT_REASON = "native_safe_replacement";
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const processAlive = (pid: number | null) => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

type ReplacementDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const listenerUnavailable = "local_runtime_api_listener_unavailable";
function historicalListenerGuardPending() {
  const profile = heartbeatRuns.runnerProfileJson, detail = nativeRunFinalizations.failureDetail;
  const providerEvents = sql.join([...NATIVE_PROVIDER_DURABLE_EVENT_TYPES].map(value => sql`${value}`), sql`, `);
  return and(
    eq(nativeRunFinalizations.failureCode, "native_session_interrupted"),
    eq(heartbeatRuns.errorCode, "native_session_interrupted"), eq(heartbeatRuns.error, listenerUnavailable),
    sql`${detail}->>'message' = ${listenerUnavailable}`,
    sql`${detail}->>'originalFailureCode' = 'native_session_interrupted'`,
    sql`${detail}->>'recoveryMode' = 'ambiguous_state'`,
    sql`${detail}->'providerSessionEstablished' = 'false'::jsonb`,
    sql`${detail}->'providerEventsExist' = 'false'::jsonb`,
    sql`${detail}->'checkpointExists' = 'false'::jsonb`,
    eq(nativeRunFinalizations.attempt, 1),
    isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.leaseExpiresAt),
    isNull(nativeRunFinalizations.assessmentId), isNull(nativeRunFinalizations.decisionId),
    isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId),
    isNull(heartbeatRuns.sessionIdBefore), isNull(heartbeatRuns.sessionIdAfter), isNull(heartbeatRuns.retryOfRunId),
    sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ?| array['cancellation', 'nativeCancellation'])`,
    sql`coalesce(${profile}->'sessionCheckpoint', 'null'::jsonb) = 'null'::jsonb`,
    sql`coalesce(${profile}->'nativeProviderPackAdmission', 'null'::jsonb) = 'null'::jsonb`,
    sql`coalesce(${profile}#>>'{nativeProviderPackAdmissionState,state}', 'pending') = 'pending'`,
    sql`${profile}#>>'{nativeExecutionInput,binding,runId}' = ${heartbeatRuns.id}::text`,
    sql`${profile}#>>'{nativeExecutionInput,binding,companyId}' = ${heartbeatRuns.companyId}::text`,
    sql`${profile}#>>'{nativeExecutionInput,binding,agentId}' = ${heartbeatRuns.agentId}::text`,
    sql`${profile}#>>'{nativeExecutionInput,binding,issueId}' = ${nativeRunFinalizations.issueId}::text`,
    sql`${profile}#>>'{nativeExecutionInput,session,normalizedSessionId}' = ${heartbeatRuns.nativeSessionId}::text`,
    sql`not exists (select 1 from ${heartbeatRuns} prior where prior.company_id = ${heartbeatRuns.companyId}
      and prior.native_session_id = ${heartbeatRuns.nativeSessionId} and prior.id <> ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${heartbeatRuns.companyId}
      and event.run_id = ${heartbeatRuns.id} and (event.source_event_id is not null
        or event.event_type in (${providerEvents}) or event.event_type ~ '^(turn|item|tool|semantic_tool|run[.]result)[.]'))`,
    sql`not exists (select 1 from ${toolInvocations} invocation where invocation.company_id = ${heartbeatRuns.companyId}
      and invocation.run_id = ${heartbeatRuns.id})`,
    sql`not exists (select 1 from ${issueRecoveryActions}
      where ${issueRecoveryActions.companyId} = ${heartbeatRuns.companyId}
        and ${issueRecoveryActions.sourceIssueId} = ${nativeRunFinalizations.issueId}
        and ${issueRecoveryActions.cause} = 'native_continuation_requires_reconciliation'
        and ${issueRecoveryActions.evidence}->>'runId' = ${heartbeatRuns.id}::text
        and ${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'
        and not coalesce((${completedWorkspaceRecoveryCondition(heartbeatRuns.id)}), false))`,
    sql`exists (select 1 from ${issues} task where task.company_id = ${heartbeatRuns.companyId}
      and task.id = ${nativeRunFinalizations.issueId} and task.assignee_agent_id = ${heartbeatRuns.agentId}
      and task.status in ('todo', 'in_progress', 'in_review', 'blocked')
      and (task.status <> 'blocked' or exists (select 1 from ${issueRecoveryActions} hold
        where hold.company_id = task.company_id and hold.source_issue_id = task.id and hold.kind = 'active_run_watchdog'
          and hold.cause = ${nativeRunFinalizations.failureCode} and hold.evidence->>'runId' = ${heartbeatRuns.id}::text
          and hold.evidence#>>'{nativeFailureBlock,runId}' = ${heartbeatRuns.id}::text
          and hold.evidence#>'{nativeFailureBlock,statusVersion}' = to_jsonb(task.status_version))))`,
  );
}

async function historicalListenerGuardEvidence(db: ReplacementDb, run: typeof heartbeatRuns.$inferSelect) {
  const [evidence] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), historicalListenerGuardPending(),
    )).limit(1);
  return Boolean(evidence);
}

/** A saved remote source is proved by its current ledger, never a controller path. */
async function remoteWorkspaceReplacementEvidence(
  db: ReplacementDb,
  run: typeof heartbeatRuns.$inferSelect,
  issueId: string,
  leases: Array<typeof environmentLeases.$inferSelect>,
  lock = false,
) {
  const [task] = await db.select({ workspaceId: issues.executionWorkspaceId }).from(issues).where(and(
    eq(issues.companyId, run.companyId), eq(issues.id, issueId),
  ));
  const query = task?.workspaceId ? db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, task.workspaceId),
  )) : null;
  const [workspace] = query ? await (lock ? query.for("update") : query) : [];
  const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
  if (run.runnerProfileJson?.remoteWorkspace == null && !authority) return null;
  if (lock) {
    const [currentRun] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id),
    )).for("update");
    if (!currentRun || currentRun.status !== "failed") return { workspacePreserved: false, providerStopped: false };
    run = currentRun;
    leases = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    )).for("update");
  }
  const providerStopped = leases.length > 0 && leases.every(hasRemoteTerminationReceipt);
  const denied = { workspacePreserved: false, providerStopped };
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!workspace || !authority || !parsed.success || parsed.data.state !== "saved" || !parsed.data.snapshotId
    || run.runnerProfileJson?.nativeWorkspaceSync != null || ["archived", "cleanup_failed"].includes(workspace.status)) return denied;
  const reference = parsed.data;
  const executionWorkspace = record(record(run.runnerProfileJson?.nativeExecutionInput).workspace);
  if (workspace.id !== reference.workspaceId || executionWorkspace.cwd !== reference.remoteCwd
    || authority.dirty || authority.writerRunId || authority.epoch !== reference.epoch
    || authority.snapshotId !== reference.snapshotId) return denied;
  const lease = leases.find(row => row.id === reference.leaseId && row.providerLeaseId === reference.providerLeaseId
    && (!row.executionWorkspaceId || row.executionWorkspaceId === workspace.id)
    && row.metadata?.remoteWorkspaceId === workspace.id && row.metadata?.remoteCwd === reference.remoteCwd);
  if (!lease || !providerStopped) return denied;
  if (authority.location ? authority.location.leaseId !== lease.id || authority.location.environmentId !== lease.environmentId
    || authority.location.providerLeaseId !== reference.providerLeaseId || authority.location.remoteCwd !== reference.remoteCwd
    : record(lease.metadata?.remoteExecutionTermination).state !== "destroyed") return denied;
  const snapshotQuery = db.select().from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, run.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
    eq(executionWorkspaceSnapshots.id, reference.snapshotId!), eq(executionWorkspaceSnapshots.status, "committed"),
    eq(executionWorkspaceSnapshots.epoch, reference.epoch), eq(executionWorkspaceSnapshots.sourceRunId, run.id),
  ));
  const [snapshot] = await (lock ? snapshotQuery.for("update") : snapshotQuery);
  if (!snapshot?.sha256 || !snapshot.objectKey || !snapshot.key || !snapshot.manifestDigest || !snapshot.byteSize) return denied;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.id, snapshot.sourceOperationId), eq(workspaceOperations.companyId, run.companyId),
    eq(workspaceOperations.executionWorkspaceId, workspace.id), eq(workspaceOperations.heartbeatRunId, run.id),
    eq(workspaceOperations.issueId, issueId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
    eq(workspaceOperations.status, "succeeded"),
    sql`${workspaceOperations.metadata}->>'boundary' = 'final'`,
    sql`${workspaceOperations.metadata}->>'epoch' = ${String(reference.epoch)}`,
    sql`${workspaceOperations.metadata}->>'snapshotId' = ${snapshot.id}`,
    sql`${workspaceOperations.metadata}->>'sha256' = ${snapshot.sha256}`,
  ));
  return { workspacePreserved: Boolean(operation), providerStopped };
}

export function nativeReplacementPending() {
  return and(
    eq(heartbeatRuns.status, "failed"),
    eq(nativeRunFinalizations.phase, "terminal_failure"),
    or(inArray(
      nativeRunFinalizations.failureCode,
      ["native_provider_terminal_failed", "native_session_cleanup_quarantined", "provider_transport_failed", ...NATIVE_POOL_FAILURE_CODES],
    ), historicalListenerGuardPending()),
    sql`(${nativeRunFinalizations.failureCode} not in ('native_provider_usage_limit', 'native_provider_auth_failed', 'native_provider_runner_failed') or exists (
      select 1 from heartbeat_run_events e where e.company_id = ${heartbeatRuns.companyId}
        and e.run_id = ${heartbeatRuns.id} and e.event_type = 'ai_connection.' || case ${nativeRunFinalizations.failureCode} when 'native_provider_auth_failed' then 'auth' when 'native_provider_runner_failed' then 'runner' else 'quota' end || '_attributed'
        and e.source_event_id = 'ai-connection-' || case ${nativeRunFinalizations.failureCode} when 'native_provider_auth_failed' then 'auth' when 'native_provider_runner_failed' then 'runner' else 'quota' end || '-attributed:' || ${heartbeatRuns.id}::text
    ))`,
    isNull(nativeRunFinalizations.resultId),
    sql`coalesce(${nativeRunFinalizations.failureDetail}->>'successorRunId', '') = ''`,
    sql`coalesce(${nativeRunFinalizations.failureDetail}->>'replacementDenied', '') = ''`,
    sql`(${nativeRunFinalizations.failureCode} not in ('native_provider_usage_limit', 'native_provider_auth_failed', 'native_provider_runner_failed') or coalesce(${heartbeatRuns.resultJson}->'executionCancellation'->>'state', '') not in ('requested', 'acknowledged'))`,
  );
}

const REPLACEMENT_SCAN_LIMIT = 100;
const replacementDiscovery = new WeakMap<object, { after: string | undefined; complete: boolean; generation: number; rescan: boolean }>();
function replacementDiscoveryState(db: Db) {
  let state = replacementDiscovery.get(db);
  if (!state) { state = { after: undefined, complete: false, generation: 0, rescan: false }; replacementDiscovery.set(db, state); }
  return state;
}

export function invalidateNativeReplacementDiscovery(db: Db) {
  const state = replacementDiscoveryState(db);
  state.complete = false; state.rescan = true; state.generation++;
}

async function replacementHistoryReady(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string, retryDatabaseErrors = false) {
  try {
    const continuation = await buildExecutionContinuation({ db, companyId: run.companyId, issueId,
      agentId: run.agentId, context: record(run.contextSnapshot), summary: null, exposeLowTrustRaw: false });
    return continuation.unresolvedInteractionIds.length === 0;
  } catch (error) {
    let cause: unknown = error;
    for (let depth = 0; retryDatabaseErrors && depth < 4 && cause && typeof cause === "object"; depth++) {
      const failure = cause as { code?: unknown; cause?: unknown };
      if (typeof failure.code === "string" && /^[A-Z0-9_]+$/.test(failure.code)) throw error;
      cause = failure.cause;
    }
    return null;
  }
}

async function discoverNativeReplacements(db: Db, after: string | undefined, limit = 25) {
  const candidates: Array<{ run: typeof heartbeatRuns.$inferSelect; coordinator: typeof nativeRunFinalizations.$inferSelect }> = [];
  let scanned = 0;
  for (;;) {
    const rows = await db.select({ run: heartbeatRuns, coordinator: nativeRunFinalizations }).from(heartbeatRuns)
      .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
      .where(and(nativeReplacementPending(), notInArray(nativeRunFinalizations.failureCode, NATIVE_POOL_FAILURE_CODES), after ? gt(heartbeatRuns.id, after) : undefined))
      .orderBy(asc(heartbeatRuns.id)).limit(Math.min(25, REPLACEMENT_SCAN_LIMIT - scanned));
    if (!rows.length) return { candidates, scanned, after: undefined };
    for (const row of rows) {
      after = row.run.id; scanned++;
      let ready = true;
      if (row.coordinator.failureCode === "native_session_interrupted") {
        ready = false;
        if (row.run.runnerProfileJson?.remoteWorkspace != null) {
          const leases = await db.select().from(environmentLeases).where(and(
            eq(environmentLeases.companyId, row.run.companyId), eq(environmentLeases.heartbeatRunId, row.run.id),
          ));
          if (leases.every(lease => lease.releasedAt !== null)) {
            const evidence = await remoteWorkspaceReplacementEvidence(db, row.run, row.coordinator.issueId, leases);
            ready = Boolean(evidence?.workspacePreserved && evidence.providerStopped)
              && await replacementHistoryReady(db, row.run, row.coordinator.issueId, true) === true;
          }
        }
      }
      if (ready) candidates.push(row);
      if (candidates.length >= limit || scanned >= REPLACEMENT_SCAN_LIMIT) return { candidates, scanned, after };
    }
    if (rows.length < 25) return { candidates, scanned, after: undefined };
  }
}

function settleReplacementDiscovery(state: ReturnType<typeof replacementDiscoveryState>, after: string | undefined, generation: number) {
  const rescan = state.rescan || generation !== state.generation;
  state.after = after; state.complete = !after && !rescan;
  state.rescan = Boolean(after && rescan);
}

export async function hasPendingNativeReplacements(db: Db) {
  const state = replacementDiscoveryState(db);
  if (state.complete) return false;
  if (state.after) return true;
  state.rescan = false;
  const generation = state.generation;
  const result = await discoverNativeReplacements(db, undefined, 1);
  if (result.candidates.length) return true;
  settleReplacementDiscovery(state, result.after, generation);
  return !state.complete;
}

/** Retryable outbox: terminal_failure plus a new-format failure code is the durable candidate. */
export async function reconcileSafeNativeReplacements(
  db: Db,
  now = new Date(),
  options: {
    verifyStoppedSession?: (run: typeof heartbeatRuns.$inferSelect) => Promise<{
      evidence: Record<string, unknown>;
      retire: () => boolean;
    } | null>;
    /** Test fault injection at durability boundaries; never exposed by an API. */
    failpoint?: (phase: "successor_inserted" | "lineage_committed") => void | Promise<void>;
  } = {},
) {
  const quotaCandidates = await db
    .select({ run: heartbeatRuns, coordinator: nativeRunFinalizations })
    .from(heartbeatRuns)
    .innerJoin(
      nativeRunFinalizations,
      eq(nativeRunFinalizations.runId, heartbeatRuns.id),
    )
    .where(
      and(nativeReplacementPending(), inArray(nativeRunFinalizations.failureCode, NATIVE_POOL_FAILURE_CODES)),
    )
    .orderBy(sql`case when ${nativeRunFinalizations.failureCode} in ('native_provider_usage_limit', 'native_provider_auth_failed', 'native_provider_runner_failed') and
        coalesce(${nativeRunFinalizations.failureDetail}->>'replacementWaitingForCleanup', 'false') = 'true' and
        exists (select 1 from environment_leases l where l.company_id = ${heartbeatRuns.companyId}
          and l.heartbeat_run_id = ${heartbeatRuns.id} and l.released_at is null
          and l.status in ('active', 'pending_cleanup') and coalesce(l.cleanup_status, '') not in ('failed', 'success')) then 2
      when ${nativeRunFinalizations.failureCode} in ('native_provider_usage_limit', 'native_provider_auth_failed', 'native_provider_runner_failed') and
        ${nativeRunFinalizations.nextAttemptAt} > ${now.toISOString()}::timestamptz then 1 else 0 end`,
      nativeRunFinalizations.nextAttemptAt, heartbeatRuns.createdAt, heartbeatRuns.id)
    .limit(25);
  const discovery = replacementDiscoveryState(db);
  if (discovery.complete) discovery.after = undefined;
  discovery.complete = false;
  if (!discovery.after) discovery.rescan = false;
  const generation = discovery.generation;
  const selection = await discoverNativeReplacements(db, discovery.after);
  const candidates = [...quotaCandidates, ...selection.candidates];
  let scheduled = 0, pendingFailures = 0;
  for (const { run, coordinator } of candidates) {
    const poolFailure = nativePoolFailureKind(coordinator.failureCode);
    const holdQuotaForOperator = async (cause: string, nextAction: string) => {
        await db.transaction(async tx => {
          const [task] = await tx.select().from(issues).where(and(
            eq(issues.id, coordinator.issueId), eq(issues.companyId, run.companyId),
          )).for("update");
          const [current] = await tx.select().from(nativeRunFinalizations).where(and(
            eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
          )).for("update");
          if (!current || current.phase !== "terminal_failure" || current.failureCode !== coordinator.failureCode ||
              current.failureDetail?.successorRunId || current.failureDetail?.replacementDenied) return;
          await notifyExecutionRunWork(tx, { companyId: run.companyId });
          await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
            failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false, replacementDenied: cause, nextAction },
          }).where(eq(nativeRunFinalizations.runId, run.id));
          if (!task || task.assigneeAgentId !== run.agentId || ["done", "cancelled"].includes(task.status)) return;
          await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
            companyId: run.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
            ownerType: "board", ownerAgentId: null, returnOwnerAgentId: run.agentId,
            cause, fingerprint: `native-replacement:${run.id}`, evidence: { runId: run.id, attempts: current.attempt },
            nextAction, wakePolicy: null, maxAttempts: 3, supersedeOnIdentityChange: true,
          });
        });
    };
    try {
      if (coordinator.failureDetail?.successorRunId || coordinator.failureDetail?.replacementDenied) continue;
      const execution = record(
        record(run.runnerProfileJson).nativeExecutionInput,
      );
      const workspace = record(execution.workspace);
      const leases = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, run.companyId),
            eq(environmentLeases.heartbeatRunId, run.id),
          ),
        );
      // Teardown is still in progress. The next sweep rechecks its durable outcome.
      if (leases.some((lease) => lease.releasedAt === null)) {
        if (Boolean(poolFailure)) {
          if (leases.some(lease => lease.releasedAt === null &&
              (!['active', 'pending_cleanup'].includes(lease.status) || ['failed', 'success'].includes(lease.cleanupStatus ?? '')))) {
            await holdQuotaForOperator("provider_ownership_unverified", "Verify the previous provider and its workspace have stopped before continuing.");
          } else {
            await db.transaction(async tx => {
              await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, coordinator.issueId), eq(issues.companyId, run.companyId))).for("update");
              const [current] = await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)).for("update");
              if (!current || current.phase !== "terminal_failure" || current.failureCode !== coordinator.failureCode || current.failureDetail?.successorRunId || current.failureDetail?.replacementDenied) return;
              const currentLeases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id))).for("update");
              if (!currentLeases.some(lease => lease.releasedAt === null) || currentLeases.some(lease => lease.releasedAt === null &&
                  (!['active', 'pending_cleanup'].includes(lease.status) || ['failed', 'success'].includes(lease.cleanupStatus ?? '')))) {
                await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
                  failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false },
                }).where(eq(nativeRunFinalizations.runId, run.id));
                return;
              }
              await tx.update(nativeRunFinalizations).set({ nextAttemptAt: null, updatedAt: now,
                failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: true },
              }).where(eq(nativeRunFinalizations.runId, run.id));
            });
          }
        }
        continue;
      }
      const historicalListener = coordinator.failureCode === "native_session_interrupted";
      if (historicalListener && !await historicalListenerGuardEvidence(db, run)) continue;
      const stoppedSession = coordinator.failureCode !== "native_provider_terminal_failed" && !historicalListener
        ? await options.verifyStoppedSession?.(run) ?? null : null;
      // A transport label alone is not evidence. Keep inspecting these candidates
      // as process cleanup and the final transcript become durable.
      if (coordinator.failureCode !== "native_provider_terminal_failed" && !historicalListener && !stoppedSession) {
        if (Boolean(poolFailure)) await holdQuotaForOperator("provider_ownership_unverified", "Verify the previous provider stopped and reconcile its complete action history before continuing.");
        continue;
      }
      const invocations = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.companyId, run.companyId),
            eq(toolInvocations.runId, run.id),
          ),
        );
      const events = await db
        .select({
          eventType: heartbeatRunEvents.eventType,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.companyId, run.companyId),
            eq(heartbeatRunEvents.runId, run.id),
            inArray(heartbeatRunEvents.eventType, [
              "harness.diagnostic",
              "semantic_tool.input",
              "semantic_tool.result",
              "tool.execution.started",
              "tool.execution.completed",
              "item.completed",
              "workspace.changed",
              "workspace.change.updated",
              "delegation.started",
              "terminal.input.sent",
              "artifact.generated",
              "item.started",
            ]),
          ),
        );
      const freshConversation = Boolean(poolFailure);
      const eventPayload = (event: { payload: unknown }) => {
        const envelope = record(event.payload);
        return envelope.prpEvent ? record(record(envelope.prpEvent).payload) : envelope;
      };
      const completedProviderActions = freshConversation ? events
        .filter(event => event.eventType === "tool.execution.completed")
        .filter(event => {
          const p = eventPayload(event);
          return typeof p.executionId === "string" && typeof p.name === "string" &&
            ["succeeded", "completed"].includes(String(p.status));
        }) : [];
      const safeControlReads = new Set([
        "connections_search",
        "connection_request",
        "paperclip_get_agent",
        "paperclip_get_issue",
        "paperclip_list_issues",
        "paperclip_read_document",
      ]);
      const uncertainProviderActions = events.flatMap((event) => {
        const p = eventPayload(event);
        if (["tool.execution.completed", "item.completed", "semantic_tool.result"].includes(event.eventType)) return [];
        if (event.eventType === "semantic_tool.input") {
          if (!freshConversation) return [];
          const call = record(p.semantic_tool);
          const settled = typeof call.callId === "string" && events.some(done => {
            const result = record(eventPayload(done).semantic_tool);
            return done.eventType === "semantic_tool.result" && result.callId === call.callId &&
              result.operationId === call.operationId && result.outcome === "succeeded";
          });
          return settled ? [] : [String(call.callId ?? "unconfirmed semantic tool")];
        }
        if (freshConversation && ["workspace.changed", "workspace.change.updated", "artifact.generated"].includes(event.eventType)) return [];
        if (event.eventType === "harness.diagnostic")
          return p.classification === "descendant"
            ? [`descendant ${String(p.receivedThreadId ?? "unknown")}`]
            : [];
        if (
          [
            "workspace.changed",
            "workspace.change.updated",
            "delegation.started",
            "terminal.input.sent",
            "artifact.generated",
          ].includes(event.eventType)
        )
          return [event.eventType];
        if (event.eventType === "tool.execution.started") {
          const name = typeof p.name === "string" ? p.name : "unknown tool";
          if (freshConversation && completedProviderActions.some(done => {
            const completed = eventPayload(done);
            const startSource = record(record(event.payload).prpEvent);
            const completedSource = record(record(done.payload).prpEvent);
            return completed.executionId === p.executionId && completed.name === name &&
              (startSource.sourceInstanceId === undefined ||
                completedSource.sourceInstanceId === startSource.sourceInstanceId &&
                Number(completedSource.sourceSeq) > Number(startSource.sourceSeq));
          })) return [];

          const completedTaskControlCallIds = stoppedSession?.evidence.completedTaskControlCallIds;
          if (name === "paperclip_finish" && Array.isArray(completedTaskControlCallIds) &&
              completedTaskControlCallIds.includes(p.executionId)) return [];
          const receiptedRead = invocations.some(
            (row) =>
              (row.id === p.executionId ||
                row.correlationId === p.executionId) &&
              row.toolName === name &&
              row.riskLevel === "read" &&
              row.status === "succeeded" &&
              row.resultHash,
          );
          return p.transport === "process" ||
            (!receiptedRead && !safeControlReads.has(name))
            ? [String(p.executionId ?? name)]
            : [];
        }
        if (freshConversation && event.eventType === "item.started") {
          const source = record(record(event.payload).prpEvent);
          if (typeof source.itemId === "string" && events.some(done => {
            const terminal = record(record(done.payload).prpEvent);
            return done.eventType === "item.completed" && terminal.itemId === source.itemId &&
              terminal.sourceInstanceId === source.sourceInstanceId && eventPayload(done).status === "completed";
          })) return [];
        }
        return [
          "command_execution",
          "commandExecution",
          "file_change",
          "fileChange",
          "collabAgentToolCall",
          "subAgentActivity",
        ].includes(String(p.kind ?? p.type))
          ? [String(p.kind ?? p.type)]
          : [];
      });
      const history = await replacementHistoryReady(db, run, coordinator.issueId);
      if (history === false) {
        if (Boolean(poolFailure)) await holdQuotaForOperator("continuation_evidence_incomplete", "Resolve the outstanding task interactions before continuing.");
        continue;
      }
      const historyComplete = history === true;
      const remoteWorkspace = await remoteWorkspaceReplacementEvidence(db, run, coordinator.issueId, leases);
      if (historicalListener && (!remoteWorkspace?.workspacePreserved || !remoteWorkspace.providerStopped || invocations.length)) continue;
      const decision = decideNativeReplacement({
        failedSession: true,
        freshConversation,
        // A facade transport failure can conceal an authoritative protocol
        // rejection. A stopped process and read receipts do not resolve that.
        failureMeaningKnown:
          Boolean(stoppedSession) || (typeof coordinator.failureDetail?.originalFailureCode === "string" &&
          ![
            "notification_transport_failed",
            "provider_turn_failed",
            "native_provider_terminal_failed",
          ].includes(coordinator.failureDetail.originalFailureCode)),
        predecessorFenced:
          coordinator.leaseOwner === null && run.status === "failed",
        providerStopped:
          !processAlive(run.processPid) &&
          !processAlive(run.processGroupId ? -run.processGroupId : null) &&
          (remoteWorkspace?.providerStopped ?? true),
        workspacePreserved: remoteWorkspace ? remoteWorkspace.workspacePreserved :
          typeof workspace.cwd === "string" &&
          (await stat(workspace.cwd).then(
            (s) => s.isDirectory(),
            () => false,
          )),
        historyComplete,
        effectInventoryComplete:
          Boolean(stoppedSession) || (record(run.runnerProfileJson).recoveryEventInventoryVersion === 1 &&
          record(execution.provider).kind === "codex"),
        attempts: poolFailure ? 0 : coordinator.attempt,
        invocations,
        apiReceipts: record(record(run.resultJson).apiToolReceipts),
        uncertainProviderActions,
      });
      if (!decision.allowed) {
        // Lack of containment can be temporary; do not prevent the next proof.
        if (decision.cause === "provider_ownership_unverified" && !poolFailure) continue;
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
          );
          const [task] = await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.id, coordinator.issueId),
                eq(issues.companyId, run.companyId),
              ),
            )
            .for("update");
          const [current] = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(eq(nativeRunFinalizations.runId, run.id))
            .for("update");
          if (
            !current ||
            current.phase !== "terminal_failure" ||
            current.failureDetail?.successorRunId ||
            current.failureDetail?.replacementDenied
          )
            return;
          await notifyExecutionRunWork(tx, { companyId: run.companyId });
          await tx
            .update(nativeRunFinalizations)
            .set({
              nextAttemptAt: null,
              failureDetail: {
                ...current.failureDetail,
                replacementWaitingForCleanup: false,
                replacementDenied: decision.cause,
                nextAction: decision.nextAction,
              },
              updatedAt: now,
            })
            .where(eq(nativeRunFinalizations.runId, run.id));
          if (
            !task ||
            task.assigneeAgentId !== run.agentId ||
            ["done", "cancelled"].includes(task.status)
          )
            return;
          await issueRecoveryActionService(
            tx as unknown as Db,
          ).upsertSourceScoped({
            companyId: run.companyId,
            sourceIssueId: coordinator.issueId,
            kind: "active_run_watchdog",
            ownerType: "board",
            ownerAgentId: null,
            returnOwnerAgentId: run.agentId,
            cause: decision.cause,
            fingerprint: `native-replacement:${run.id}`,
            evidence: { runId: run.id, attempts: coordinator.attempt },
            nextAction: decision.nextAction,
            wakePolicy: null,
            maxAttempts: 3,
            supersedeOnIdentityChange: true,
          });
        });
        continue;
      }
      let cooling = false;
      let stopFenced = false;
      const created = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
        );
        const [task] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, coordinator.issueId),
              eq(issues.companyId, run.companyId),
            ),
          )
          .for("update");
        const [current] = await tx
          .select()
          .from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, run.id))
          .for("update");
        if (
          !task ||
          task.assigneeAgentId !== run.agentId ||
          !["todo", "in_progress", "in_review", "blocked"].includes(task.status) ||
          (task.executionRunId !== null && task.executionRunId !== run.id) ||
          (task.checkoutRunId !== null && task.checkoutRunId !== run.id) ||
          !current ||
          current.phase !== "terminal_failure" ||
          current.leaseOwner !== null ||
          current.failureCode !== coordinator.failureCode ||
          current.failureDetail?.successorRunId ||
          current.failureDetail?.replacementDenied ||
          (!poolFailure && current.attempt >= 3)
        )
          return false;
        let historicalRun: typeof heartbeatRuns.$inferSelect | undefined;
        if (historicalListener) {
          const [currentRun] = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
          )).for("update");
          historicalRun = currentRun;
        }
        if (task.status === "blocked") {
          const failureHolds = await tx.select().from(issueRecoveryActions).where(and(
            eq(issueRecoveryActions.companyId, run.companyId),
            eq(issueRecoveryActions.sourceIssueId, task.id),
            eq(issueRecoveryActions.kind, "active_run_watchdog"),
            eq(issueRecoveryActions.cause, current.failureCode!),
            sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          )).for("update");
          const ownsBlock = failureHolds.some(hold => {
            const receipt = record(hold.evidence.nativeFailureBlock);
            return receipt.runId === run.id && receipt.statusVersion === task.statusVersion;
          });
          if (!ownsBlock) return false;
        }
        const preservationHolds = historicalListener ? await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.kind, "active_run_watchdog"),
          eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
          sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`,
        )).for("update") : [];
        if (historicalListener && (!historicalRun || !await historicalListenerGuardEvidence(tx, historicalRun))) return false;
        if (remoteWorkspace) {
          const currentWorkspace = await remoteWorkspaceReplacementEvidence(tx, run, coordinator.issueId, leases, true);
          if (!currentWorkspace?.workspacePreserved || !currentWorkspace.providerStopped) return false;
        }
        if (stoppedSession) {
          const [currentRun] = await tx.select().from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
          )).for("update");
          if (Boolean(nativePoolFailureKind(current.failureCode)) && currentRun &&
              ["requested", "acknowledged"].includes(String(record(record(currentRun.resultJson).executionCancellation).state))) {
            stopFenced = true;
            return false;
          }
          if (!currentRun || currentRun.status !== "failed" || currentRun.runnerInstanceId !== run.runnerInstanceId ||
              currentRun.nativeSessionId !== run.nativeSessionId || currentRun.processPid || currentRun.processGroupId ||
              currentRun.retryOfRunId !== run.retryOfRunId || currentRun.issueId !== run.issueId ||
              ["requested", "acknowledged"].includes(String(record(record(currentRun.resultJson).executionCancellation).state)) ||
              !isDeepStrictEqual(currentRun.contextSnapshot, run.contextSnapshot)) return false;
        }
        let quotaSelection: AiConnectionRouterSelection | undefined;
        let quotaCycleReset = false;
        if (Boolean(nativePoolFailureKind(current.failureCode))) {
          // The cooldown is account-wide; only the run-bound attribution receipt
          // proves that this particular execution exhausted its selected account.
          const context = record(run.contextSnapshot);
          const selection = record(context.aiRouterSelection);
          const binding = record(selection.binding);
          const taskKey = context.aiRouterTaskKey;
          const poolId = selection.poolId;
          if (run.scopeKind !== "issue" || run.issueId !== task.id ||
              typeof taskKey !== "string" || (taskKey !== task.id && taskKey !== task.identifier) ||
              typeof poolId !== "string" || typeof selection.memberId !== "string" ||
              typeof binding.connectionId !== "string" || typeof binding.grantId !== "string") return false;
          const [receipt] = await tx.select().from(heartbeatRunEvents).where(and(
            eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
            eq(heartbeatRunEvents.agentId, run.agentId), isNull(heartbeatRunEvents.sourceInstanceId),
            eq(heartbeatRunEvents.eventType, `ai_connection.${poolFailure}_attributed`),
            eq(heartbeatRunEvents.sourceEventId, `ai-connection-${poolFailure}-attributed:${run.id}`),
          ));
          const attribution = record(receipt?.payload);
          if (attribution.schema !== `paperclip.ai-connection-${poolFailure}-attribution.v1` ||
              attribution.companyId !== run.companyId || attribution.runId !== run.id ||
              attribution.agentId !== run.agentId || attribution.poolId !== poolId ||
              attribution.taskKey !== taskKey || attribution.memberId !== selection.memberId ||
              attribution.connectionId !== binding.connectionId || attribution.grantId !== binding.grantId ||
              !isDeepStrictEqual(attribution.selection, selection) ||
              typeof attribution.retryAt !== "string" || !Number.isFinite(Date.parse(attribution.retryAt))) return false;
          const attemptedMemberIds = [selection.memberId];
          const attemptedRuns = [run];
          const seenRuns = new Set([run.id]);
          let predecessorId = run.retryOfRunId;
          let childId = run.id;
          let childContext = record(run.contextSnapshot);
          while (predecessorId) {
            if (record(childContext.aiPoolFailover).sourceRunId !== predecessorId) break;
            if (seenRuns.has(predecessorId) || seenRuns.size >= 100) return false;
            seenRuns.add(predecessorId);
            const [predecessor] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.id, predecessorId), eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
            ));
            if (!predecessor || predecessor.issueId !== run.issueId) return false;
            const [predecessorFinalization] = await tx.select().from(nativeRunFinalizations).where(and(
              eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, predecessor.id),
            ));
            if (!predecessorFinalization || !["terminal_failure", "superseded"].includes(predecessorFinalization.phase) || !nativePoolFailureKind(predecessorFinalization.failureCode) ||
                predecessorFinalization.failureDetail?.successorRunId !== childId) return false;
            if (predecessorFinalization?.failureDetail?.quotaCycleResetSuccessorRunId === childId &&
                predecessorFinalization.failureDetail.successorRunId === childId) break;
            const previous = record(record(predecessor.contextSnapshot).aiRouterSelection);
            if (previous.poolId !== poolId || typeof previous.memberId !== "string") return false;
            if (attemptedMemberIds.includes(previous.memberId)) return false;
            attemptedMemberIds.push(previous.memberId);
            attemptedRuns.push(predecessor);
            childId = predecessor.id;
            childContext = record(predecessor.contextSnapshot);
            predecessorId = predecessor.retryOfRunId;
          }
          const [agent] = await tx.select().from(agents).where(and(
            eq(agents.companyId, run.companyId), eq(agents.id, run.agentId),
          )).for("share");
          const configured = record(effectiveAiConnectionInput(agent?.runtimeConfig));
          if (!agent || configured.mode !== "router" || configured.connectionId !== poolId) return false;
          const router = aiConnectionRouterService(tx as unknown as Db);
          const transitionInput = {
            companyId: run.companyId, poolId, agentId: run.agentId, taskKey,
            expectedSelection: selection as unknown as AiConnectionRouterSelection,
            userId: run.responsibleUserId, adapterType: agent.adapterType, attemptedMemberIds,
            failureKind: poolFailure!,
            sourceAdapterConfig: { ...record(agent.adapterConfig), ...record(record(task.assigneeAdapterOverrides).adapterConfig) },
          };
          let transition = await router.transitionQuotaPin(transitionInput);
          if (transition.kind !== "selected") {
            const [pool] = await tx.select().from(aiConnectionPools).where(and(
              eq(aiConnectionPools.companyId, run.companyId), eq(aiConnectionPools.id, poolId),
            ));
            if (!pool) return false;
            const eligible = new Set<string>();
            const future: Date[] = transition.kind === "cooldown" ? [transition.retryAt] : [];
            for (const attempted of attemptedRuns) {
              const attemptedSelection = record(record(attempted.contextSnapshot).aiRouterSelection);
              const attemptedBinding = record(attemptedSelection.binding);
              const [attemptedOwner] = await tx.select().from(nativeRunFinalizations).where(and(
                eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, attempted.id)));
              const attemptedKind = nativePoolFailureKind(attemptedOwner?.failureCode);
              if (!attemptedKind) continue;
              const [proof] = await tx.select().from(heartbeatRunEvents).where(and(
                eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, attempted.id),
                eq(heartbeatRunEvents.agentId, run.agentId), isNull(heartbeatRunEvents.sourceInstanceId),
                eq(heartbeatRunEvents.eventType, `ai_connection.${attemptedKind}_attributed`),
                eq(heartbeatRunEvents.sourceEventId, `ai-connection-${attemptedKind}-attributed:${attempted.id}`),
              ));
              const p = record(proof?.payload);
              if (p.schema !== `paperclip.ai-connection-${attemptedKind}-attribution.v1` || p.companyId !== run.companyId ||
                  p.runId !== attempted.id || p.agentId !== run.agentId || p.poolId !== poolId || p.taskKey !== taskKey ||
                  p.memberId !== attemptedSelection.memberId || p.connectionId !== attemptedBinding.connectionId ||
                  p.grantId !== attemptedBinding.grantId || !isDeepStrictEqual(p.selection, attemptedSelection) ||
                  typeof p.quotaIdentityHash !== "string" || typeof p.retryAt !== "string" ||
                  !Number.isFinite(Date.parse(p.retryAt)) || typeof attemptedBinding.connectionId !== "string" ||
                  typeof attemptedSelection.memberId !== "string") continue;
              const matchingMember = pool.config.members.find(member => member.id === attemptedSelection.memberId &&
                isDeepStrictEqual(member.binding, attemptedBinding));
              if (!matchingMember) continue;
              const observed = await router.currentMemberCooldown({ companyId: run.companyId, agentId: run.agentId,
                userId: run.responsibleUserId, adapterType: agent.adapterType, member: matchingMember, failureKind: attemptedKind,
                runnerScope: typeof record(attemptedSelection.runnerScope).environmentId === "string"
                  ? { environmentId: String(record(attemptedSelection.runnerScope).environmentId) }
                  : Object.hasOwn(record(attemptedSelection.runnerScope), "environmentId") ? { environmentId: null } : undefined,
                sourceAdapterConfig: transitionInput.sourceAdapterConfig });
              if (!observed || (observed.identityHash === p.quotaIdentityHash && !observed.recorded)) continue;
              const deadline = Math.max(observed.retryAt?.getTime() ?? 0,
                observed.identityHash === p.quotaIdentityHash ? Date.parse(p.retryAt) : 0);
              if (deadline > now.getTime()) future.push(new Date(deadline));
              else eligible.add(attemptedSelection.memberId);
            }
            if (eligible.size) {
              transition = await router.transitionQuotaPin({ ...transitionInput,
                attemptedMemberIds: pool.config.members.filter(member => !eligible.has(member.id)).map(member => member.id),
              });
              quotaCycleReset = transition.kind === "selected";
            } else if (future.length) {
              transition = { kind: "cooldown", retryAt: new Date(Math.min(...future.map(date => date.getTime()))) };
            }
          }
          if (transition.kind === "cooldown") {
            await tx.update(nativeRunFinalizations).set({ nextAttemptAt: transition.retryAt, updatedAt: now,
              failureDetail: { ...current.failureDetail, replacementWaitingForCleanup: false, nextAction: `Wait for an eligible account to become available at ${transition.retryAt.toISOString()}.` },
            }).where(eq(nativeRunFinalizations.runId, run.id));
            cooling = true;
            return false;
          }
          if (transition.kind !== "selected") return false;
          quotaSelection = transition.selection;
        }
        if (task.status === "blocked") {
          // Restore only this failure's unchanged projection. The normal issue
          // service still enforces dependency readiness and assignee eligibility.
          await issueService(tx as unknown as Db).update(task.id, { status: "in_progress" }, tx);
        }
        if (stoppedSession) {
          // If the last ownership proof changes, roll back the status restoration.
          if (!stoppedSession.retire()) throw new Error("native_replacement_stopped_session_changed");
          await appendHeartbeatRunEvent(tx as unknown as Db, {
            companyId: run.companyId, runId: run.id, agentId: run.agentId,
            eventType: freshConversation ? "native.stopped_conversation_verified" : "native.stopped_text_turn_verified", stream: "system", level: "info",
            message: freshConversation
              ? "The previous runner and provider stopped. A fresh conversation will preserve completed actions without replaying them."
              : "The previous runner and provider stopped. The interrupted turn had no external actions; any completion bookkeeping has a verified receipt.",
            payload: stoppedSession.evidence,
          });
        }
        const successorRunId = randomUUID();
        const dueAt = quotaSelection ? now : new Date(now.getTime() + 30_000);
        const predecessorContext = { ...record(run.contextSnapshot) };
        if (quotaSelection) {
          predecessorContext.aiRouterSelection = quotaSelection;
          predecessorContext.aiPoolFailover = { sourceRunId: run.id, reason: poolFailure };
          delete predecessorContext.aiConnection;
        }
        // History comes from the failed source run. Consumed wake fields must
        // not grant this automatic retry fresh comment/resume authority.
        for (const key of [
          "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
          "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
          "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
          "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
        ]) delete predecessorContext[key];
        const context = {
          ...predecessorContext,
          issueId: task.id,
          retryOfRunId: run.id,
          wakeReason: NATIVE_SAFE_REPLACEMENT_REASON,
          retryReason: NATIVE_SAFE_REPLACEMENT_REASON,
          forceFreshSession: true,
          recoveryIncidentRootRunId:
            record(run.contextSnapshot).recoveryIncidentRootRunId ?? run.id,
        };
        const [wake] = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: run.companyId,
            agentId: run.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: NATIVE_SAFE_REPLACEMENT_REASON,
            status: "queued",
            payload: context,
            requestedByActorType: "system",
            idempotencyKey: `native-safe-replacement:${run.id}`,
          })
          .returning();
        await notifyExecutionRunWork(tx, { companyId: run.companyId });
        await notifyScheduledRetryDispatch(tx, { companyId: run.companyId });
        await tx.insert(heartbeatRuns).values({
          id: successorRunId,
          companyId: run.companyId,
          agentId: run.agentId,
          ...(quotaSelection ? { scopeKind: "issue" as const, issueId: task.id } : {}),
          invocationSource: "automation",
          triggerDetail: "system",
          status: "scheduled_retry",
          executionStatusDeliveryId: randomUUID(),
          wakeupRequestId: wake!.id,
          responsibleUserId: run.responsibleUserId,
          contextSnapshot: context,
          retryOfRunId: run.id,
          scheduledRetryAt: dueAt,
          scheduledRetryAttempt: poolFailure ? run.scheduledRetryAttempt + 1 : current.attempt,
          scheduledRetryReason: NATIVE_SAFE_REPLACEMENT_REASON,
        });
        await options.failpoint?.("successor_inserted");
        await tx
          .update(agentWakeupRequests)
          .set({ runId: successorRunId })
          .where(eq(agentWakeupRequests.id, wake!.id));
        await tx
          .update(nativeRunFinalizations)
          .set({
            failureDetail: {
              ...current.failureDetail,
              ...(quotaCycleReset ? { quotaCycleResetSuccessorRunId: successorRunId } : {}),
              ...(quotaSelection ? { poolFailover: { sourceRunId: run.id, reason: poolFailure, selection: quotaSelection } } : {}),
              ...(stoppedSession ? freshConversation
                ? { stoppedConversation: stoppedSession.evidence }
                : { stoppedTextTurn: stoppedSession.evidence } : {}),
              successorRunId,
              nextAction:
                "Continue in the linked fresh provider session after the retry delay.",
            },
            nextAttemptAt: dueAt,
            updatedAt: now,
          })
          .where(eq(nativeRunFinalizations.runId, run.id));
        await issueRecoveryActionService(
          tx as unknown as Db,
        ).resolveActiveForIssue({
          companyId: run.companyId,
          sourceIssueId: task.id,
          kind: "active_run_watchdog",
          fingerprint: createHash("sha256")
            .update(`${run.id}:${current.failureCode}`)
            .digest("hex"),
          status: "resolved",
          outcome: "handed_back",
          resolutionNote: `Safe continuation is scheduled in run ${successorRunId}.`,
        });
        // A previous sweep can have resolved the UI bookkeeping while retaining
        // an effective no-replay hold. Retire only this exact failure's hold in
        // the same transaction as its verified successor; unrelated holds remain.
        const holds = await tx.select().from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.kind, "active_run_watchdog"),
          eq(issueRecoveryActions.cause, current.failureCode!),
          sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
        )).for("update");
        holds.push(...preservationHolds);
        if (holds.some(hold => hold.status === "active" || hold.status === "escalated")) {
          await notifyUnsafeWorkspaceExportRecovery(tx, { companyId: run.companyId, issueId: task.id });
        }
        for (const hold of holds) {
          await tx.update(issueRecoveryActions).set({
            status: "resolved", outcome: "handed_back", resolvedAt: now, updatedAt: now,
            wakePolicy: null, monitorPolicy: null,
            nextAction: `Safe continuation is scheduled in run ${successorRunId}.`,
            resolutionNote: "Verified process termination and action receipts allow a fresh session to continue.",
            evidence: { ...hold.evidence, verifiedReplacement: { successorRunId, recordedAt: now.toISOString() },
              ...(hold.evidence.automaticRecovery ? { automaticRecovery: {
                ...record(hold.evidence.automaticRecovery), replay: "verified_safe_replacement", successorRunId,
              } } : {}),
            },
          }).where(eq(issueRecoveryActions.id, hold.id));
        }
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: randomUUID() })
          .where(eq(heartbeatRuns.id, run.id));
        await notifyNativeStatusReassessment(tx, { companyId: run.companyId, issueId: task.id });
        // The successor gets task authority only through the existing admission gate.
        await tx
          .update(issues)
          .set({ executionRunId: null, checkoutRunId: null, updatedAt: now })
          .where(
            and(
              eq(issues.id, task.id),
              eq(issues.assigneeAgentId, run.agentId),
            ),
          );
        return true;
      });
      if (created) {
        await options.failpoint?.("lineage_committed");
        scheduled += 1;
      } else if (!cooling && !stopFenced && Boolean(poolFailure)) {
        await holdQuotaForOperator("quota_failover_unavailable", "Inspect account permissions, pool configuration, and the original run before choosing a recovery action.");
      }
    } catch (error) {
      if (options.failpoint) throw error;
      // An interrupted decision is not evidence that replacement is unsafe.
      // Only completed negative proofs above may permanently deny recovery.
      pendingFailures++;
      logger.warn(
        { runId: run.id },
        "Native replacement remains pending; another sweep will retry its durable decision",
      );
    }
  }
  settleReplacementDiscovery(discovery, selection.after, generation);
  if (pendingFailures) {
    discovery.complete = false; discovery.rescan = true;
    throw new Error("native_replacement_decision_retry_required");
  }
  return { scanned: quotaCandidates.length + selection.scanned, scheduled };
}
