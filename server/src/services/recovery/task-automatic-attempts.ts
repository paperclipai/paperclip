import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, type Db } from "@paperclipai/db";
import { CONTINUATION_CAP, CONTINUATION_CAP_WINDOW_MS } from "./assigned-work-invariant.js";

export const ASSIGNED_WORK_CONTINUED_ACTION = "issue.continued_automatically";
export const SCHEDULER_TRANSIENT_RETRY_REASON = "transient_failure";

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

export async function transientRetryWithinTaskCap(db: Db, companyId: string, issueId: string, at: Date) {
  const attempts = await taskAutomaticAttempts(db, companyId, issueId, at);
  return attempts.continuations.length === 0 || attempts.all.length < CONTINUATION_CAP;
}
