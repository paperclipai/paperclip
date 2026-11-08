import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { notifyDeferredExecutionEligibility, notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";

/**
 * Work-intent outbox (durable ownership plan, section E; invariant 4).
 *
 * An accepted work intent (assignment, comment, Retry, recovery) ends in one
 * of a closed set of terminal outcomes. Every other refusal is temporary: the
 * intent is saved as `deferred_issue_execution` with an `executionWait` that
 * names the refusal and the hold-release event that clears it. Each such event
 * calls `promoteDeferredWorkIntents`, and the ownership reconciler calls it as
 * a backstop for a missed event. Promotion re-runs normal admission; it never
 * bypasses a gate, and the existing compare-and-swap promotion plus the
 * per-comment consumption check keep delivery exactly once.
 */

/** The only terminal outcomes of an accepted work intent. */
export const WORK_INTENT_TERMINAL_OUTCOMES = ["delivered", "consumed", "task_cancelled", "hard_stop"] as const;
export type WorkIntentTerminalOutcome = (typeof WORK_INTENT_TERMINAL_OUTCOMES)[number];

/** Hold-release events. Each promotes the intents its hold deferred. */
export const WORK_INTENT_HOLD_TRIGGERS = [
  "accounting_settled", "lock_released", "pause_lifted", "tree_hold_released", "scheduling_resumed", "reconciler_backstop",
] as const;
export type WorkIntentHoldTrigger = (typeof WORK_INTENT_HOLD_TRIGGERS)[number];

/** Temporary refusals of an accepted intent, and the event that clears each.
 * A refusal not listed here is either a terminal outcome (a reached hard
 * stop, a cancelled or reassigned task) or a signal that was never accepted
 * work (a disabled timer, no actionable work). */
export const TEMPORARY_REFUSAL_TRIGGERS: Readonly<Record<string, WorkIntentHoldTrigger>> = {
  "budget.blocked": "pause_lifted",
  "company.inactive": "pause_lifted",
  "agent.not_invokable": "pause_lifted",
  "issue_tree_hold_active": "tree_hold_released",
  "heartbeat.scheduling_suppressed": "scheduling_resumed",
};

export function temporaryRefusalTrigger(reason: string): WorkIntentHoldTrigger | null {
  return TEMPORARY_REFUSAL_TRIGGERS[reason] ?? null;
}

/** The `executionWait` saved on a deferred intent. */
export function deferredWorkIntentWait(reason: string, message: string, details: Record<string, unknown> = {}) {
  return { ...details, reason, trigger: temporaryRefusalTrigger(reason), message };
}

/** Saved intents back off 30 s after each refusal (deferred-receipt-work.ts).
 * A hold-release event makes the intents it may clear due at once. */
const DEFERRED_RETRY_BACKOFF = sql`interval '30 seconds'`;

/**
 * The one promotion path for deferred work intents. Call it inside a
 * transaction, normally the one that releases a hold (accounting settled, a lock released, a
 * pause lifted). It wakes queued-run dispatch, the saved-receipt worker and
 * stranded-work recovery for the company, and hints each saved intent of the
 * issue by id. All notifications publish on commit.
 */
export async function promoteDeferredWorkIntents(tx: object, input: {
  companyId: string; trigger: WorkIntentHoldTrigger; issueId?: string | null;
}) {
  // Register the work signals before the write they announce.
  await notifyRunDispatch(tx, { companyId: input.companyId });
  await notifyDeferredExecutionEligibility(tx, { companyId: input.companyId });
  await notifyIssueRecovery(tx, { companyId: input.companyId });
  if (input.issueId) await notifyDeferredWakesForIssue(tx, { companyId: input.companyId, issueId: input.issueId });
  const db = tx as Pick<Db, "update">;
  await db.update(agentWakeupRequests).set({
    updatedAt: sql`least(${agentWakeupRequests.updatedAt}, now() - ${DEFERRED_RETRY_BACKOFF})`,
  }).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
    sql`${agentWakeupRequests.updatedAt} > now() - ${DEFERRED_RETRY_BACKOFF}`,
    input.issueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}` : undefined,
  ));
}
