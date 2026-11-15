import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { ASSIGNED_WORK_CONTINUED_ACTION, AUTOMATIC_RETRY_REASONS, SCHEDULER_TRANSIENT_RETRY_REASON, freshContinuationTimes, startedOrPendingAutomaticRetry } from "./continuation-ledger.js";
import { CONTINUATION_CAP, CONTINUATION_CAP_WINDOW_MS } from "./assigned-work-invariant.js";

export { ASSIGNED_WORK_CONTINUED_ACTION, SCHEDULER_TRANSIENT_RETRY_REASON };
export const PAUSED_FOR_AUTOMATIC_WORK = "pausedForAutomaticWork";

export async function taskAutomaticAttempts(db: Db, companyId: string, issueId: string, at: Date) {
  const since = new Date(at.getTime() - CONTINUATION_CAP_WINDOW_MS);
  const [continuations, transientRetries] = await Promise.all([
    db.select({ createdAt: activityLog.createdAt, outcome: sql<string | null>`${activityLog.details}->>'outcome'` }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION), gte(activityLog.createdAt, since),
      sql`coalesce(${activityLog.details}->>'continuedFromSavedWork', '') <> 'true'`,
      sql`coalesce(${activityLog.details}->>${PAUSED_FOR_AUTOMATIC_WORK}, '') <> 'true'`))
      .orderBy(desc(activityLog.createdAt)).limit(64),
    db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      inArray(heartbeatRuns.scheduledRetryReason, AUTOMATIC_RETRY_REASONS), gte(heartbeatRuns.createdAt, since),
      startedOrPendingAutomaticRetry()))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(64),
  ]);
  const freshRecords = await freshContinuationTimes(db, companyId, issueId, since);
  const sweepFresh = freshRecords.filter(record => record.trigger === "assigned_work").map(record => record.at);
  const fresh = freshRecords.filter(record => record.trigger !== "assigned_work").map(record => record.at);
  const sweep = [...continuations.map(row => row.createdAt), ...sweepFresh];
  const others = [...transientRetries.map(row => row.createdAt), ...fresh];
  const all = [...sweep, ...others];
  const started = [...continuations.filter(row => row.outcome !== "not_started").map(row => row.createdAt), ...sweepFresh, ...others];
  return { continuations: sweep, all, started };
}

export async function transientRetryWithinTaskCap(db: Db, companyId: string, issueId: string, at: Date) {
  const attempts = await taskAutomaticAttempts(db, companyId, issueId, at);
  return attempts.continuations.length === 0 || attempts.started.length < CONTINUATION_CAP;
}
