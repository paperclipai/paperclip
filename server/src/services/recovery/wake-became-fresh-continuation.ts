import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { canonicalExecutionUuid } from "../execution-identity.js";

/**
 * True when admission coalesced a continuation wake into a fresh continuation
 * from saved work. The continuation is still pending (admission already woke
 * its worker), or the worker delivered it as a run before this read. The
 * caller proved no run of the task was live before its wake, so a live
 * delivered continuation run is that wake's work. One read, no transaction:
 * the sweep runs this after every refused wake.
 */
export async function wakeBecameFreshContinuation(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const delivery = sql`${issueRecoveryActions.evidence}->>'continuationDelivery'`;
  const [row] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' is not null`,
    sql`((${issueRecoveryActions.status} = 'resolved' and ${delivery} = 'pending')
      or (${delivery} = 'delivered' and exists (select 1 from ${heartbeatRuns} continuation
        where continuation.company_id = ${issueRecoveryActions.companyId}
          and continuation.id = ${canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'continuationRunId'`)}
          and continuation.status in ('queued', 'running'))))`)).limit(1)
    .catch(error => {
      logger.warn({ err: error, companyId, issueId }, "assigned-work sweep could not read the task's continuation");
      return [];
    });
  return Boolean(row);
}
