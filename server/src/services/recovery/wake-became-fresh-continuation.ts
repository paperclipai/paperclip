import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { hasPendingFreshContinuation } from "../fresh-continuation-fallback.js";

/**
 * True when admission coalesced a continuation wake into a fresh continuation
 * from saved work. The continuation is still pending, or the continuation
 * worker already delivered it as a run before this read. The caller proved no
 * run of the task was live before its wake, so a live delivered continuation
 * run is that wake's work.
 */
export async function wakeBecameFreshContinuation(db: Db, companyId: string, issueId: string): Promise<boolean> {
  return db.transaction(async tx => {
    if (await hasPendingFreshContinuation(tx as unknown as Db, companyId, issueId)) return true;
    const [delivered] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
        sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'continuationRunId'`))
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
        sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' is not null`,
        sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'delivered'`,
        inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
    return Boolean(delivered);
  }).catch(error => {
    logger.warn({ err: error, companyId, issueId }, "assigned-work sweep could not read the task's continuation");
    return false;
  });
}
