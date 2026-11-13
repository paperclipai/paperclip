import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { CONTINUATION_CAP, CONTINUATION_CAP_WINDOW_MS } from "./assigned-work-invariant.js";

/** Activity action recorded for every automatic continuation by the
 * assigned-work sweep; also its durable claim and per-task ledger. */
export const ASSIGNED_WORK_CONTINUED_ACTION = "issue.continued_automatically";
/** The scheduler's bounded transient-failure lane (heartbeat/retries.ts). */
export const SCHEDULER_TRANSIENT_RETRY_REASON = "transient_failure";

/**
 * The one per-task ledger of automatic attempts in the last hour, read the same
 * way by both owners: the sweep's continuations and the scheduler's transient
 * retries of the task's runs. Both spend one CONTINUATION_CAP per hour.
 */
export async function taskAutomaticAttempts(db: Db, companyId: string, issueId: string, at: Date) {
  const since = new Date(at.getTime() - CONTINUATION_CAP_WINDOW_MS);
  const [continuations, transientRetries] = await Promise.all([
    db.select({ createdAt: activityLog.createdAt }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION), gte(activityLog.createdAt, since)))
      .orderBy(desc(activityLog.createdAt)).limit(64),
    db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      inArray(heartbeatRuns.scheduledRetryReason, [SCHEDULER_TRANSIENT_RETRY_REASON]), gte(heartbeatRuns.createdAt, since)))
      .orderBy(desc(heartbeatRuns.createdAt)).limit(64),
  ]);
  const all = [...continuations, ...transientRetries].map(row => row.createdAt);
  return { continuations: continuations.map(row => row.createdAt), all };
}

/** The scheduler's side of the shared cap: once the sweep has continued this
 * task in the hour, a transient retry is one more automatic attempt and stops
 * when the task's hourly cap is spent. A task the sweep never continued keeps
 * the scheduler's own per-chain bound only. */
export async function transientRetryWithinTaskCap(db: Db, companyId: string, issueId: string, at: Date) {
  const attempts = await taskAutomaticAttempts(db, companyId, issueId, at);
  return attempts.continuations.length === 0 || attempts.all.length < CONTINUATION_CAP;
}
