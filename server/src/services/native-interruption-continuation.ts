import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { RESTART_CLASS_FAILURE_CODES, isRestartClassFailureCode } from "./continuation-cause.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { continueFreshInTransaction, recordFreshContinuationCheck } from "./fresh-continuation-fallback.js";
import { nativeReplacementPending } from "./native-runtime/native-safe-replacement.js";

export function nativeInterruptionHold() {
  return and(
    inArray(issueRecoveryActions.cause, [...RESTART_CLASS_FAILURE_CODES]),
    eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.nativePhase, "terminal_failure"),
    eq(nativeRunFinalizations.phase, "terminal_failure"), isNull(nativeRunFinalizations.nextAttemptAt),
    not(nativeReplacementPending()!),
  )!;
}

export async function continueNativeInterruption(tx: Db, input: {
  action: typeof issueRecoveryActions.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
  coordinator: typeof nativeRunFinalizations.$inferSelect | undefined;
  now: Date;
}): Promise<boolean> {
  const { action, run, coordinator, now } = input;
  if (!isRestartClassFailureCode(action.cause) || run.runtimeMode !== "native" || run.nativePhase !== "terminal_failure"
    || coordinator?.phase !== "terminal_failure" || coordinator.nextAttemptAt || coordinator.leaseOwner || coordinator.resultId)
    return false;
  const fresh = await continueFreshInTransaction(tx, { companyId: action.companyId, runId: run.id, trigger: "recovery_refused", now });
  await recordFreshContinuationCheck(tx, { companyId: action.companyId, actionId: action.id }, fresh, now);
  return true;
}

export async function nextNativeInterruptionCheckAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ at: sql<string | null>`min((${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}')::bigint)` })
    .from(issueRecoveryActions)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      eq(heartbeatRuns.id, canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`))))
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
      eq(nativeRunFinalizations.runId, heartbeatRuns.id)))
    .where(and(inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.kind, "active_run_watchdog"),
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}' is not null`,
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.resultId), nativeInterruptionHold()));
  return row?.at ? Number(row.at) : null;
}
