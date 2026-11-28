import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";

export const ASSIGNED_WORK_CONTINUED_ACTION = "issue.continued_automatically";
export const SCHEDULER_TRANSIENT_RETRY_REASON = "transient_failure";
export const AUTOMATIC_RETRY_REASONS = [SCHEDULER_TRANSIENT_RETRY_REASON, "server_restart", "interrupted_preparation"];
export const SHARED_CONTINUATION_WINDOW_MS = 60 * 60_000;

export function startedOrPendingAutomaticRetry() {
  return sql`not (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.startedAt} is null
    and coalesce(${heartbeatRuns.errorCode}, '') = 'execution_reconciliation_required')`;
}

export async function freshContinuationTimes(db: Db, companyId: string, issueId: string, since: Date) {
  const rows = await db.select({ recordedAt: sql<string>`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`,
    trigger: sql<string | null>`${issueRecoveryActions.evidence}#>>'{freshContinuation,trigger}'` }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}' > ${since.toISOString()}`)).limit(64);
  return rows.map(row => ({ at: new Date(row.recordedAt), trigger: row.trigger }))
    .filter(record => Number.isFinite(record.at.getTime()) && record.at.getTime() > since.getTime());
}

export async function sharedContinuationAttempts(db: Db, companyId: string, issueId: string, at: Date): Promise<Date[]> {
  const since = new Date(at.getTime() - SHARED_CONTINUATION_WINDOW_MS);
  const [plainContinuations, retries, fresh] = await Promise.all([
    db.select({ createdAt: activityLog.createdAt }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION), gte(activityLog.createdAt, since),
      sql`${activityLog.details}->>'outcome' = 'queued'`,
      sql`coalesce(${activityLog.details}->>'continuedFromSavedWork', '') <> 'true'`)).limit(64),
    db.select({ createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      inArray(heartbeatRuns.scheduledRetryReason, AUTOMATIC_RETRY_REASONS), gte(heartbeatRuns.createdAt, since),
      startedOrPendingAutomaticRetry())).limit(64),
    freshContinuationTimes(db, companyId, issueId, since),
  ]);
  return [...plainContinuations.map(row => row.createdAt), ...retries.map(row => row.createdAt), ...fresh.map(record => record.at)]
    .sort((a, b) => a.getTime() - b.getTime());
}
