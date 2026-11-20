import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type RunError = { error: string | null; errorCode: string | null };
type RetryRunError = RunError & { retryOfRunId: string | null; scheduledRetryReason: string | null };

/**
 * A scheduled retry is created with `error`/`errorCode` set to why it was
 * scheduled, which describes its predecessor. Once the retry itself ends, that
 * note is not the retry's own failure. Terminal writers read the run's own
 * cause through these helpers so they do not report the predecessor's outcome.
 */
export function ownRunError(run: RetryRunError): RunError {
  const inherited = run.retryOfRunId != null && run.scheduledRetryReason != null && run.errorCode === run.scheduledRetryReason;
  return inherited ? { error: null, errorCode: null } : { error: run.error, errorCode: run.errorCode };
}

/** `ownRunError` as UPDATE expressions; column references read the row before the update. */
export function ownRunErrorSql() {
  const inherited = sql`(${heartbeatRuns.retryOfRunId} is not null and ${heartbeatRuns.scheduledRetryReason} is not null
    and ${heartbeatRuns.errorCode} = ${heartbeatRuns.scheduledRetryReason})`;
  return {
    error: sql`case when ${inherited} then null else ${heartbeatRuns.error} end`,
    errorCode: sql`case when ${inherited} then null else ${heartbeatRuns.errorCode} end`,
  };
}
