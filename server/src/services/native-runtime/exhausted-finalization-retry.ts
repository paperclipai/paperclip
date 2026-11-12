import { and, eq, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { nativeSha256 } from "./canonical.js";

/**
 * A provider-succeeded native run whose accepted result could not be applied
 * to its task: finalization used its whole retry budget and the coordinator
 * rests `terminal_failure` with `native_finalization_retry_exhausted`. Retry
 * re-applies that saved result. It never starts a provider run.
 *
 * Rows saved by older builds carry the same phase and code, with or without
 * `finalizationFailureCount`, so they qualify without a migration.
 */
export const EXHAUSTED_FINALIZATION_FAILURE_CODE = "native_finalization_retry_exhausted";
export const EXHAUSTED_FINALIZATION_RETRY_KIND = "exhausted_finalization_retry";
/** If the immediate re-finalization is lost (for example, a restart), the result-commit worker runs it then. */
const REFINALIZATION_FALLBACK_DELAY_MS = 30_000;

/** True for a run row whose saved result only needs finalizing again. Correlated on `heartbeat_runs`. */
export function exhaustedNativeFinalizationCondition(): SQL<boolean> {
  return sql<boolean>`(${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'succeeded'
    and exists (select 1 from ${nativeRunFinalizations}
      inner join ${nativeRunResults} on ${nativeRunResults.id} = ${nativeRunFinalizations.resultId}
        and ${nativeRunResults.companyId} = ${nativeRunFinalizations.companyId}
        and ${nativeRunResults.runId} = ${nativeRunFinalizations.runId}
        and ${nativeRunResults.schemaStatus} = 'accepted'
      where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.issueId} = ${heartbeatRuns.nativeIssueId}
        and ${nativeRunFinalizations.phase} = 'terminal_failure'
        and ${nativeRunFinalizations.failureCode} = ${EXHAUSTED_FINALIZATION_FAILURE_CODE}
        and ${nativeRunFinalizations.leaseOwner} is null
        and ${nativeRunFinalizations.failureDetail}->'successorRunId' is null))`;
}

/**
 * True while a saved-result Retry of this succeeded run is still being applied
 * (including its bounded automatic retries). The task shows work in progress.
 * The finalizer ends it by committing or by going terminal again.
 */
export function savedResultRetryPendingCondition(): SQL<boolean> {
  return sql<boolean>`(${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'succeeded'
    and exists (select 1 from ${nativeRunFinalizations}
      where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.resultId} is not null
        and ${nativeRunFinalizations.phase} not in ('committed', 'terminal_failure')
        and ${nativeRunFinalizations.recoveryHistory} @> ${JSON.stringify([{ kind: EXHAUSTED_FINALIZATION_RETRY_KIND }])}::jsonb))`;
}

/**
 * Caller holds the task lock and has proven `runId` is the task's latest run
 * by its current assignee. Reopens the coordinator for the same saved result
 * with a fresh finalization budget.
 *
 * - `rearmed`: this call reopened the coordinator.
 * - `joined`: an earlier saved-result Retry of this run already reopened it
 *   (still finalizing, or applied). A later click joins it and never starts
 *   provider work; `generationId` names that earlier Retry.
 * - `not_eligible`: the caller keeps its ordinary Retry.
 */
export async function rearmExhaustedNativeFinalization(tx: Db, input: {
  companyId: string; issueId: string; runId: string; generationId: string; actorId: string;
}): Promise<{ kind: "rearmed" } | { kind: "joined"; generationId: string | null; finalizing: boolean }
  | { kind: "not_eligible" }> {
  const [eligible] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.nativeIssueId, input.issueId), exhaustedNativeFinalizationCondition(),
  )).limit(1);
  // The caller holds the task row. The finalizer locks coordinator then task,
  // so never wait for a coordinator that may be finalizing: read it unlocked,
  // and lock it only when it rests terminal, where no finalizer holds it.
  const readCoordinator = (lock: boolean) => {
    const query = tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
      eq(nativeRunFinalizations.issueId, input.issueId)));
    return (lock ? query.for("update") : query).then(rows => rows[0]);
  };
  const classify = (row: typeof nativeRunFinalizations.$inferSelect) => {
    // Joining is read-only. If the earlier Retry goes terminal meanwhile, this
    // click still starts no provider work and the task offers Retry again.
    const earlier = row.phase === "terminal_failure" ? undefined
      : row.recoveryHistory.findLast(entry => entry.kind === EXHAUSTED_FINALIZATION_RETRY_KIND);
    return earlier ? { kind: "joined" as const, finalizing: row.phase !== "committed",
      generationId: typeof earlier.generationId === "string" ? earlier.generationId : null } : { kind: "not_eligible" as const };
  };
  const exhausted = (row: typeof nativeRunFinalizations.$inferSelect) => row.phase === "terminal_failure"
    && row.failureCode === EXHAUSTED_FINALIZATION_FAILURE_CODE && !row.leaseOwner;
  const observed = await readCoordinator(false);
  if (!observed?.resultId) return { kind: "not_eligible" };
  if (!eligible || !exhausted(observed)) return classify(observed);
  const coordinator = await readCoordinator(true);
  if (!coordinator?.resultId) return { kind: "not_eligible" };
  if (!exhausted(coordinator)) {
    const changed = classify(coordinator);
    // Changed under us: fail closed rather than fall back to a provider Retry.
    return changed.kind === "joined" ? changed : { kind: "joined", finalizing: true, generationId: null };
  }
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + REFINALIZATION_FALLBACK_DELAY_MS);
  const phase = coordinator.assessmentId ? "arbitrating" : "workspace_finalizing";
  await notifyNativeFinalizationWork(tx, { companyId: input.companyId, runId: input.runId, issueId: input.issueId });
  await tx.update(nativeRunFinalizations).set({
    phase, nextAttemptAt, failureCode: null, failureDetail: null, updatedAt: now,
    recoveryHistory: [...coordinator.recoveryHistory, {
      kind: EXHAUSTED_FINALIZATION_RETRY_KIND, generationId: input.generationId, requestedByUserId: input.actorId,
      resultId: coordinator.resultId, previousFailureCode: coordinator.failureCode,
      previousFailureDetail: coordinator.failureDetail, at: now.toISOString(),
    }],
  }).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId),
    eq(nativeRunFinalizations.phase, "terminal_failure")));
  // The board card asked for this Retry. A new failure raises its own card.
  // Loaded on use: task presentation reads this module's condition.
  const { issueRecoveryActionService } = await import("../issue-recovery-actions.js");
  await issueRecoveryActionService(tx).resolveActiveForIssue({
    companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog",
    cause: EXHAUSTED_FINALIZATION_FAILURE_CODE,
    fingerprint: nativeSha256({ runId: input.runId, failureCode: EXHAUSTED_FINALIZATION_FAILURE_CODE }),
    status: "resolved", outcome: "handed_back",
    resolutionNote: "Retry applies the saved result again, without another provider turn.",
  }, tx);
  // A deliberate Retry is a new durable intent, so it gets a fresh budget.
  await tx.update(heartbeatRuns).set({
    nativePhase: phase, nativePhaseUpdatedAt: now, updatedAt: now,
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      finalizationPhase: phase, finalizationFailureCount: 0, failureCode: null, nextAttemptAt: nextAttemptAt.toISOString(),
    })}::jsonb`,
  }).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  return { kind: "rearmed" };
}

/**
 * Applies the saved result now, after `rearmExhaustedNativeFinalization`
 * committed. Same-run finalization only: it keeps the provider attempt count
 * and records a failure through the finalizer's own bounded budget.
 */
export async function refinalizeSavedNativeResult(db: Db, input: { companyId: string; runId: string }) {
  const [barrier] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.heartbeatRunId, input.runId),
    eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"),
  )).limit(1);
  // Without a saved workspace the reconciler resumes the workspace step first.
  if (!barrier) return null;
  // Loaded on use: task presentation reads this module's condition.
  const { finalizeNativeRun, NativeFinalizationDeferredError, recordNativeFinalizationFailure } =
    await import("./native-run-finalizer.js");
  try {
    return await finalizeNativeRun({ db, runId: input.runId, workspaceFinalizeStatus: "succeeded",
      projectRunStatus: true, preserveProviderAttempt: true });
  } catch (error) {
    if (error instanceof NativeFinalizationDeferredError) return null;
    return recordNativeFinalizationFailure({ db, runId: input.runId, error, projectRunStatus: true });
  }
}
