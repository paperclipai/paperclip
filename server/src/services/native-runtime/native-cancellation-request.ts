import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { badRequest, conflict } from "../../errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function cancellationRequestId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !UUID.test(value)) throw badRequest("Invalid cancellationRequestId");
  return value.toLowerCase();
}
export const cancellationIntentId = (requestId: string) => `native-cancellation:${requestId}`;

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

/** Evaluate only while both the run and coordinator are locked. A UUID alone
 * is not retry authority; a resumed Stop needs its exact durable native intent. */
export function nativeRetryCancellationEligible(input: {
  runId: string; companyId: string; issueId: string; resultJson: unknown; requestId?: string; scope?: string;
}, coordinator: { phase?: string; failureCode?: string | null } | null | undefined) {
  if (coordinator?.phase === "retryable_failure") return true;
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
