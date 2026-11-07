import { nativePoolFailureKind } from "./native-pool-failure.js";
import { notifyScheduledRetryCancellation } from "../scheduled-retry-cancellation-notifications.js";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, budgetReservations, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { badRequest, conflict } from "../../errors.js";
import { nativeManualAdmissionHoldMatches } from "./native-runner-ownership.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function cancellationRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest("Invalid cancellationRequestId");
  return value.toLowerCase();
}
export const cancellationIntentId = (requestId: string) => `native-cancellation:${requestId}`;

type StopRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "nativeIssueId" | "runtimeMode" | "status" | "resultJson">;
type StopRecoveryOwner = Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "phase" | "resultId" | "leaseOwner" | "leaseExpiresAt" | "controllerGeneration" | "attempt" | "recoveryState" | "recoveryHistory">;

export function hasPendingNativeRunStop(run: StopRun): boolean {
  const intent = record(record(run.resultJson).nativeCancellation);
  return run.runtimeMode === "native" && !!run.nativeIssueId
    && intent.schema === "paperclip.native-cancellation.v1" && intent.scope === "run" && intent.reasonCode === "cancellation_run_only"
    && intent.runId === run.id && intent.companyId === run.companyId && intent.issueId === run.nativeIssueId
    && typeof intent.intentId === "string" && intent.intentId.startsWith("native-cancellation:")
    && UUID.test(intent.intentId.slice("native-cancellation:".length))
    && typeof intent.intentAuditId === "string" && UUID.test(intent.intentAuditId)
    && intent.dispatchState === "pending" && intent.dispatched === false
    && Array.isArray(intent.effects) && intent.effects.length === 1 && intent.effects[0] === "release_run_resources";
}

export function isClaimedNativeStopRecovery(run: StopRun, owner: StopRecoveryOwner | undefined, leaseOwner: string | undefined, now = Date.now()): boolean {
  if (!leaseOwner || !hasPendingNativeRunStop(run) || run.status !== "running" || !owner
    || owner.runId !== run.id || owner.companyId !== run.companyId || owner.issueId !== run.nativeIssueId
    || owner.phase !== "observed" || owner.resultId || owner.leaseOwner !== leaseOwner
    || !owner.leaseExpiresAt || owner.leaseExpiresAt.getTime() <= now || owner.recoveryState !== "awaiting_runner_reattach") return false;
  const latest = record(Array.isArray(owner.recoveryHistory) ? owner.recoveryHistory.at(-1) : null);
  return latest.disposition === "reattach_remote_runner" && latest.controllerGeneration === owner.controllerGeneration
    && latest.providerAttempt === owner.attempt;
}

export async function readPendingNativeRunStop(db: Db, run: StopRun): Promise<boolean> {
  if (!hasPendingNativeRunStop(run)) return false;
  const intent = record(record(run.resultJson).nativeCancellation);
  const [audit] = await db.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.id, intent.intentAuditId as string), eq(activityLog.companyId, run.companyId),
    eq(activityLog.runId, run.id), eq(activityLog.entityId, run.id), eq(activityLog.entityType, "heartbeat_run"),
    eq(activityLog.action, "native.cancellation_intent_recorded"),
  )).limit(1);
  return !!audit;
}

export async function readClaimedNativeStopRecovery(db: Db, run: StopRun, leaseOwner?: string): Promise<boolean> {
  if (!leaseOwner || !await readPendingNativeRunStop(db, run)) return false;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
    eq(nativeRunFinalizations.issueId, run.nativeIssueId!),
  )).limit(1);
  if (!isClaimedNativeStopRecovery(run, owner, leaseOwner)) return false;
  const [hold] = await db.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
    eq(budgetReservations.companyId, run.companyId), eq(budgetReservations.runId, run.id),
    eq(budgetReservations.agentId, run.agentId), eq(budgetReservations.state, "held"),
  )).limit(1);
  return !!hold;
}

/** Run only while holding this company's run row lock. An earlier uncorrelated
 * startup fence is also a conflicting Stop, even before native intent exists. */
export function assertCancellationRequest(result: unknown, requestId: string, allowUnclaimed = false) {
  const value = record(result), startup = record(value.startupCancellation), native = record(value.nativeCancellation);
  if ((Object.hasOwn(value, "startupCancellation") && startup.cancellationRequestId !== requestId)
    || (Object.hasOwn(value, "nativeCancellation") && native.intentId !== cancellationIntentId(requestId))
    || (!allowUnclaimed && startup.cancellationRequestId !== requestId)) {
    throw conflict("Cancellation request conflicts with an earlier Stop");
  }
}

/** Serialize board Stop with quota replacement; no provider termination is inferred. */
export async function fenceQuotaReplacementStop(db: Db, source: typeof heartbeatRuns.$inferSelect, requestId?: string, userId: string | null = null) {
  if (source.runtimeMode !== "native" || source.status !== "failed" || !source.nativeIssueId) return null;
  return db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, source.companyId), eq(issues.id, source.nativeIssueId!),
    )).for("update");
    if (!issue) return null;
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, source.id), eq(nativeRunFinalizations.companyId, source.companyId),
      eq(nativeRunFinalizations.issueId, source.nativeIssueId!),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, source.id), eq(heartbeatRuns.companyId, source.companyId),
    )).for("update");
    if (!run || run.status !== "failed" || owner?.phase !== "terminal_failure"
      || !nativePoolFailureKind(owner.failureCode)) return null;
    const successorId = record(owner.failureDetail).successorRunId;
    if (successorId !== undefined && successorId !== null) {
      if (typeof successorId !== "string" || successorId === run.id) throw conflict("Invalid quota replacement lineage");
      const [successor] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, successorId), eq(heartbeatRuns.companyId, run.companyId),
        eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.retryOfRunId, run.id),
      )).limit(1);
      if (!successor) throw conflict("Quota replacement lineage changed");
      return { kind: "successor" as const, run: successor };
    }
    const result = record(run.resultJson);
    if (requestId) {
      if (cancellationRequestId(requestId) !== requestId) throw badRequest("Invalid cancellationRequestId");
      assertCancellationRequest(result, requestId, true);
      const prior = record(result.startupCancellation);
      const actor = record(prior.requestedBy);
      if (prior.cancellationRequestId === requestId && (actor.type !== "board" || actor.userId !== userId)) {
        throw conflict("Cancellation request belongs to another actor");
      }
    }
    const requestedAt = new Date().toISOString();
    const [fenced] = await tx.update(heartbeatRuns).set({ resultJson: { ...result,
      executionCancellation: { state: "requested", requestedAt },
      ...(requestId ? { startupCancellation: { requestedAt, beforeNativeSelection: false,
        cancellationRequestId: requestId, requestedBy: { type: "board", userId } } }
        : { startupCancellation: result.startupCancellation ?? { requestedAt, beforeNativeSelection: false } }),
    } }).where(eq(heartbeatRuns.id, run.id)).returning();
    return { kind: "fenced" as const, run: fenced! };
  });
}

/** Evaluate only while both the run and coordinator are locked. A UUID alone
 * is not retry authority; a resumed Stop needs its exact durable native intent. */
export function nativeRetryCancellationEligible(input: {
  runId: string; companyId: string; issueId: string; resultJson: unknown; requestId?: string; scope?: string;
}, coordinator: Partial<Pick<typeof nativeRunFinalizations.$inferSelect,
  "runId" | "companyId" | "issueId" | "phase" | "resultId" | "failureCode" | "failureDetail">> | null | undefined) {
  if (coordinator?.phase === "retryable_failure") return true;
  if (coordinator?.failureCode === "native_restart_recovery_blocked" && nativeManualAdmissionHoldMatches(input, coordinator)) return true;
  if (coordinator?.phase !== "terminal_failure" || coordinator.failureCode !== "native_retry_cancelled") return false;
  const result = record(input.resultJson), native = record(result.nativeCancellation);
  return (!input.requestId || (record(result.startupCancellation).cancellationRequestId === input.requestId
      && native.intentId === cancellationIntentId(input.requestId)))
    && native.schema === "paperclip.native-cancellation.v1" && typeof native.intentId === "string" && !!native.intentId
    && native.runId === input.runId && native.companyId === input.companyId && native.issueId === input.issueId
    && native.scope === (input.scope ?? "run") && ["pending", "acknowledged"].includes(String(native.dispatchState))
    && typeof native.dispatched === "boolean" && typeof native.intentAuditId === "string" && !!native.intentAuditId
    && (native.dispatchState === "pending" || (typeof native.acknowledgementAuditId === "string"
      && !!native.acknowledgementAuditId && native.acknowledgementAuditId !== native.intentAuditId));
}

export function pendingFailedNativeRetryCancellationCondition() {
  const native = sql`${heartbeatRuns.resultJson}->'nativeCancellation'`;
  const continuingStop = sql`${nativeRunFinalizations.phase} = 'terminal_failure'
    and ${nativeRunFinalizations.failureCode} = 'native_retry_cancelled'
    and ${native}->>'schema' = 'paperclip.native-cancellation.v1'
    and jsonb_typeof(${native}->'intentId') = 'string' and length(${native}->>'intentId') > 0
    and ${native}->>'runId' = ${heartbeatRuns.id}::text
    and ${native}->>'companyId' = ${heartbeatRuns.companyId}::text
    and ${native}->>'issueId' = ${heartbeatRuns.nativeIssueId}::text
    and ${native}->>'scope' = 'run'
    and ${native}->>'dispatchState' in ('pending', 'acknowledged')
    and jsonb_typeof(${native}->'dispatched') = 'boolean'
    and jsonb_typeof(${native}->'intentAuditId') = 'string' and length(${native}->>'intentAuditId') > 0
    and (${native}->>'dispatchState' = 'pending' or (
      jsonb_typeof(${native}->'acknowledgementAuditId') = 'string'
      and length(${native}->>'acknowledgementAuditId') > 0
      and ${native}->>'acknowledgementAuditId' <> ${native}->>'intentAuditId'))`;
  return sql`${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'failed'
    and exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.issueId} = ${heartbeatRuns.nativeIssueId}
        and (${nativeRunFinalizations.phase} = 'retryable_failure' or (${continuingStop}))
        and ${nativeRunFinalizations.resultId} is null)`;
}

/** Final failed -> cancelled CAS: a later board/recovery outcome must win.
 * The row-locking subquery prevents a coordinator-only writer from changing
 * the retry disposition between this check and the status update. */
export function nativeRetryCancellationCommitCondition(expectedResult: unknown) {
  const native = record(record(expectedResult).nativeCancellation);
  if (native.dispatchState !== "acknowledged" || typeof native.runId !== "string"
    || typeof native.companyId !== "string" || typeof native.issueId !== "string"
    || !nativeRetryCancellationEligible({ runId: native.runId, companyId: native.companyId,
      issueId: native.issueId, resultJson: expectedResult }, { phase: "terminal_failure", failureCode: "native_retry_cancelled" })) {
    return sql`false`;
  }
  return sql`${heartbeatRuns.status} = 'failed' and ${heartbeatRuns.runtimeMode} = 'native'
    and ${heartbeatRuns.id} = ${native.runId} and ${heartbeatRuns.companyId} = ${native.companyId}
    and ${heartbeatRuns.nativeIssueId} = ${native.issueId}
    and ${heartbeatRuns.resultJson} = ${JSON.stringify(expectedResult)}::jsonb
    and exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.issueId} = ${heartbeatRuns.nativeIssueId}
        and ${nativeRunFinalizations.phase} = 'terminal_failure'
        and ${nativeRunFinalizations.failureCode} = 'native_retry_cancelled'
      for update nowait)`;
}

export function rethrowNativeCancellationLockConflict(error: unknown): never {
  const value = record(error);
  if (value.code === "55P03" || record(value.cause).code === "55P03") {
    throw conflict("Native retry cancellation is busy; retry the same request");
  }
  throw error;
}

/** Reserve the caller's identity before handoff or dispatch. No schema change:
 * the existing startup fence and native intent carry the correlation. */
export async function claimCancellationRequest(db: Db, runId: string, companyId: string, requestId: string, userId: string | null) {
  if (cancellationRequestId(requestId) !== requestId) throw badRequest("Invalid cancellationRequestId");
  if (userId !== null && (typeof userId !== "string" || !userId)) throw badRequest("Invalid cancellation request actor");
  return db.transaction(async tx => {
    const run = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .for("update").limit(1).then(rows => rows[0]);
    if (!run || run.runtimeMode !== "native") throw conflict("Correlated Stop requires a native run");
    assertCancellationRequest(run.resultJson, requestId, true);
    const result = record(run.resultJson);
    let pendingRetry = false;
    if (run.status === "failed" && run.nativeIssueId) {
      // Eligibility and the caller fence must share a transaction. Coordinator
      // writers need not lock the run. NOWAIT avoids a lock-order deadlock with
      // execution's coordinator -> run claim; a busy claim can be retried.
      const coordinator = await tx.select().from(nativeRunFinalizations)
        .where(and(eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.companyId, companyId),
          eq(nativeRunFinalizations.issueId, run.nativeIssueId)))
        .for("update", { noWait: true }).limit(1).then(rows => rows[0]);
      pendingRetry = nativeRetryCancellationEligible({ runId, companyId, issueId: run.nativeIssueId,
        resultJson: result, requestId }, coordinator);
    }
    if (record(result.startupCancellation).cancellationRequestId === requestId) {
      const actor = record(record(result.startupCancellation).requestedBy);
      if (actor.type !== "board" || actor.userId !== userId) throw conflict("Cancellation request belongs to another actor");
      if (!pendingRetry && !["queued", "running", "scheduled_retry"].includes(run.status)) {
        const native = record(result.nativeCancellation);
        if (run.status !== "cancelled" || native.schema !== "paperclip.native-cancellation.v1"
          || native.intentId !== cancellationIntentId(requestId) || native.runId !== runId || native.companyId !== companyId
          || native.scope !== "run" || native.dispatchState !== "acknowledged" || typeof native.dispatched !== "boolean"
          || typeof native.intentAuditId !== "string" || !native.intentAuditId
          || typeof native.acknowledgementAuditId !== "string" || !native.acknowledgementAuditId
          || native.intentAuditId === native.acknowledgementAuditId) throw conflict("Correlated Stop run is already terminal without acknowledgement");
      }
      return run;
    }
    if (!pendingRetry && !["queued", "running", "scheduled_retry"].includes(run.status)) throw conflict("Correlated Stop run is already terminal");
    await notifyScheduledRetryCancellation(tx, { companyId, runId });
    const [claimed] = await tx.update(heartbeatRuns).set({ resultJson: { ...result,
      startupCancellation: { requestedAt: new Date().toISOString(), beforeNativeSelection: false, cancellationRequestId: requestId, requestedBy: { type: "board", userId }, ...(run.status === "failed" ? { retryCancellation: true } : {}) },
    } }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).returning();
    if (!claimed) throw conflict("Correlated Stop run changed");
    return claimed;
  }).catch(rethrowNativeCancellationLockConflict);
}

/** Used by the default Stop path too: never erase a correlated reservation. */
export function startupCancellationFence(requestedAt: string) {
  return sql`CASE
    WHEN ${heartbeatRuns.resultJson}->'startupCancellation'->>'cancellationRequestId' IS NOT NULL
      THEN ${heartbeatRuns.resultJson}->'startupCancellation'
    ELSE jsonb_build_object('requestedAt', ${requestedAt}::text,
      'beforeNativeSelection', ${heartbeatRuns.runtimeMode} = 'legacy'
        and ${heartbeatRuns.runtimeModeResolvedAt} is null
        and ${heartbeatRuns.executionStage} = 'preparing'
        and coalesce(${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType' = 'paperclip_runner', false))
    END`;
}
