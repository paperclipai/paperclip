/**
 * Issue-scoped cancellation of pending scheduled retries.
 *
 * A `scheduled_retry` heartbeat run is a parked row: it holds no process, but
 * it WILL fire when `scheduledRetryAt` arrives. When the issue it belongs to
 * is cancelled (or blocked), that parked row is a liability - it wakes the
 * assignee for work nobody wants anymore.
 *
 * Historically the issue-cancellation path only looked for a `running` run
 * (see `resolveActiveIssueRun` in routes/issues.ts), so a cancelled issue
 * kept its retry ladder alive and the retry fired minutes later against a
 * cancelled issue. The promotion gate (`evaluateScheduledRetryGate`) then
 * suppressed the retry at the last moment - which is why the defect was
 * invisible in the run table: the row was cancelled, but only AFTER it had
 * already been woken, and it had already consumed a run slot.
 *
 * This module owns the "find every pending retry for this issue and cancel
 * it" logic so both the issue route and the agent-reachable cancel route can
 * share it.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Statuses that count as "a parked retry that will fire later".
 *
 * `scheduled_retry` is the parked row itself. `queued` is included because a
 * promoted retry lands in `queued` before it starts running; cancelling the
 * issue while it sits in the queue must also stop it.
 */
export const ISSUE_CANCELLABLE_RETRY_STATUSES = ["scheduled_retry", "queued"] as const;

export type IssuePendingRetry = {
  id: string;
  agentId: string;
  status: string;
  scheduledRetryAt: Date | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryOfRunId: string | null;
};

/**
 * Find every QUEUED run belonging to an issue, whether or not it is a retry.
 *
 * A queued run is a wake that has been granted but has not started yet. It
 * holds the issue's execution lock (`issues.executionRunId`) while it waits,
 * so a queued run against a cancelled issue blocks the issue indefinitely -
 * the wake is only cancelled later, by the stale-queued-run gate, IF the agent
 * happens to be invoked at all. Measured on this instance before the fix: 32
 * queued runs against a terminal issue, the oldest 26 hours old, each holding
 * a lock on work nobody wants.
 *
 * This is why the sweep is not limited to retry rows: a first-attempt queued
 * run is just as dead as a parked retry once the issue is cancelled.
 */
export async function listQueuedIssueRuns(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<IssuePendingRetry[]> {
  return db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
      scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
      retryOfRunId: heartbeatRuns.retryOfRunId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
    );
}

/**
 * Find every pending retry row belonging to an issue.
 *
 * The issue link lives in `contextSnapshot.issueId` (the retry run carries the
 * issue it was scheduled for). `retryOfRunId is not null` narrows to actual
 * retry rows - a first-attempt run is never a "pending retry" and must not be
 * swept up by an issue cancellation.
 */
export async function listPendingIssueRetries(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<IssuePendingRetry[]> {
  return db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
      scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
      retryOfRunId: heartbeatRuns.retryOfRunId,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, [...ISSUE_CANCELLABLE_RETRY_STATUSES]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.retryOfRunId} is not null`,
      ),
    );
}

/**
 * True when the run is a retry row parked against the given issue.
 *
 * Used by the agent-reachable cancel route to decide whether a caller may
 * cancel a run without a board key: an agent may always cancel its OWN
 * pending retry for its own issue.
 */
export async function runIsPendingIssueRetry(
  db: Db,
  input: { companyId: string; runId: string; issueId: string },
): Promise<boolean> {
  const rows = await listPendingIssueRetries(db, input);
  return rows.some((row) => row.id === input.runId);
}
