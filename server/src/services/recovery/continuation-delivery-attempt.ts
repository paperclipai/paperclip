import { and, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

export const CONTINUATION_AGENT_WAIT_BASE_MS = 60_000;
export const CONTINUATION_AGENT_WAIT_MAX_MS = 60 * 60_000;

type PendingAction = Pick<typeof issueRecoveryActions.$inferSelect, "companyId" | "id">;

const pendingDelivery = (action: PendingAction) => and(
  eq(issueRecoveryActions.companyId, action.companyId),
  eq(issueRecoveryActions.id, action.id),
  eq(issueRecoveryActions.status, "resolved"),
  sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
);

/** Records a delivery attempt for a pending continuation, so the next pass tries the records not yet tried first. */
export function recordContinuationDeliveryAttempt(db: Db, action: PendingAction) {
  return db.update(issueRecoveryActions)
    .set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
      { continuationDeliveryAttemptedAt: new Date().toISOString() })}::jsonb` })
    .where(pendingDelivery(action));
}

export function continuationAgentWait(evidence: Record<string, unknown>, now = new Date()) {
  const recorded = Number(evidence.continuationDeliveryAgentWaits ?? 0);
  const prior = Number.isSafeInteger(recorded) && recorded > 0 ? recorded : 0;
  const delay = Math.min(CONTINUATION_AGENT_WAIT_MAX_MS, CONTINUATION_AGENT_WAIT_BASE_MS * 2 ** Math.min(prior, 20));
  return { waits: prior + 1, retryAt: new Date(now.getTime() + delay) };
}

export function recordContinuationAgentWait(db: Db, action: PendingAction & Pick<typeof issueRecoveryActions.$inferSelect, "evidence">,
  now = new Date()) {
  const { waits, retryAt } = continuationAgentWait(action.evidence, now);
  return db.update(issueRecoveryActions)
    .set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ continuationDeliveryAttemptedAt: now.toISOString(),
      continuationDeliveryRetryAt: retryAt.toISOString(), continuationDeliveryAgentWaits: waits })}::jsonb` })
    .where(pendingDelivery(action));
}

export function continuationDeliveryDue(now: Date) {
  return sql`coalesce((${issueRecoveryActions.evidence}->>'continuationDeliveryRetryAt')::timestamptz <= ${now.toISOString()}::timestamptz, true)`;
}

export async function readmitAgentContinuations(tx: Db, input: { companyId: string; agentId: string }) {
  const readmitted = await tx.update(issueRecoveryActions)
    .set({ evidence: sql`${issueRecoveryActions.evidence} - 'continuationDeliveryRetryAt' - 'continuationDeliveryAgentWaits'` })
    .where(and(
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.returnOwnerAgentId, input.agentId),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
      sql`${issueRecoveryActions.evidence} ? 'continuationDeliveryRetryAt'`,
    ))
    .returning({ id: issueRecoveryActions.id });
  if (readmitted.length) await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
}
