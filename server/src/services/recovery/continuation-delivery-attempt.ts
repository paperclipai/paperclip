import { and, eq, sql } from "drizzle-orm";
import { issueRecoveryActions, type Db } from "@paperclipai/db";

/** Records a delivery attempt for a pending continuation, so the next pass tries the records not yet tried first. */
export function recordContinuationDeliveryAttempt(db: Db, action: Pick<typeof issueRecoveryActions.$inferSelect, "companyId" | "id">) {
  return db.update(issueRecoveryActions)
    .set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(
      { continuationDeliveryAttemptedAt: new Date().toISOString() })}::jsonb` })
    .where(and(
      eq(issueRecoveryActions.companyId, action.companyId),
      eq(issueRecoveryActions.id, action.id),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    ));
}
