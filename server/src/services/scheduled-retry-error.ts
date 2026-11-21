import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type RunError = { error: string | null; errorCode: string | null };
type RetryRunError = RunError & { retryOfRunId: string | null; scheduledRetryReason: string | null; resultJson?: unknown };

/**
 * `resultJson` key for a stop cause this run proved itself, such as a runner
 * stop at the tool receipt limit. It is saved before the status decision
 * commits, so every terminal writer (live completion, the native projection
 * and restart repair) reads the same cause.
 */
export const RUN_STOP_CAUSE_KEY = "runStopCause";

export function runStopCauseResult(cause: { errorCode: string; error: string }) {
  return { [RUN_STOP_CAUSE_KEY]: { errorCode: cause.errorCode, error: cause.error } };
}

function readRunStopCause(resultJson: unknown): RunError | null {
  if (!resultJson || typeof resultJson !== "object") return null;
  const cause = (resultJson as Record<string, unknown>)[RUN_STOP_CAUSE_KEY];
  if (!cause || typeof cause !== "object") return null;
  const { errorCode, error } = cause as Record<string, unknown>;
  return typeof errorCode === "string" && typeof error === "string" ? { errorCode, error } : null;
}

/**
 * A scheduled retry is created with `error`/`errorCode` set to why it was
 * scheduled, which describes its predecessor. Once the retry itself ends, that
 * note is not the retry's own failure. Terminal writers read the run's own
 * cause through these helpers so they do not report the predecessor's outcome.
 *
 * Another recorded cause wins. Otherwise a saved stop cause applies, including
 * one whose code matches the scheduling reason (a receipt-limit continuation
 * that stops at the limit again).
 */
export function ownRunError(run: RetryRunError): RunError {
  const inherited = run.retryOfRunId != null && run.scheduledRetryReason != null && run.errorCode === run.scheduledRetryReason;
  if (!inherited && (run.error != null || run.errorCode != null)) return { error: run.error, errorCode: run.errorCode };
  return readRunStopCause(run.resultJson) ?? { error: null, errorCode: null };
}

/** `ownRunError` as UPDATE expressions; column references read the row before the update. */
export function ownRunErrorSql() {
  const inherited = sql`(${heartbeatRuns.retryOfRunId} is not null and ${heartbeatRuns.scheduledRetryReason} is not null
    and ${heartbeatRuns.errorCode} is not distinct from ${heartbeatRuns.scheduledRetryReason})`;
  const recorded = sql`(not ${inherited} and (${heartbeatRuns.error} is not null or ${heartbeatRuns.errorCode} is not null))`;
  const stopCauseKey = sql.raw(`'${RUN_STOP_CAUSE_KEY}'`);
  const stopCause = sql`(case when jsonb_typeof(${heartbeatRuns.resultJson}->${stopCauseKey}->'errorCode') = 'string'
    and jsonb_typeof(${heartbeatRuns.resultJson}->${stopCauseKey}->'error') = 'string'
    then ${heartbeatRuns.resultJson}->${stopCauseKey} end)`;
  return {
    error: sql<string | null>`case when ${recorded} then ${heartbeatRuns.error} else ${stopCause}->>'error' end`,
    errorCode: sql<string | null>`case when ${recorded} then ${heartbeatRuns.errorCode} else ${stopCause}->>'errorCode' end`,
  };
}
