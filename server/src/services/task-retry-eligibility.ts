import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";

const REFUSALS_A_CLICK_CANNOT_CHANGE: ReadonlySet<string> = new Set([
  "cancelled_by_operator", "retry_source_changed", "workspace_owner_stop_required", "previous_execution_unverified",
]);

export function heldRetryOffersRetry(reason: string | null | undefined, cleanupSettling = false): boolean {
  if (!reason) return true;
  return !REFUSALS_A_CLICK_CANNOT_CHANGE.has(reason) && (reason !== "cleanup_quarantined" || !cleanupSettling);
}

export async function heldTaskRetryRefusals(db: Pick<Db, "selectDistinctOn">, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (!issueIds.length) return new Map();
  const issueId = sql<string>`${agentWakeupRequests.payload}->>'issueId'`;
  const rows = await db.selectDistinctOn([issueId], { issueId, sourceRunId: sql<string | null>`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
    reason: sql<string | null>`${agentWakeupRequests.payload}#>>'{executionWait,reason}'`,
    latestRunId: sql<string | null>`(select latest.id::text from ${heartbeatRuns} latest
      where latest.company_id = ${companyId} and (latest.issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.native_issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.context_snapshot->>'issueId' = ${agentWakeupRequests.payload}->>'issueId')
      order by latest.created_at desc, latest.id desc limit 1)` })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), inArray(issueId, issueIds),
      sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' is not null`))
    .orderBy(issueId, desc(agentWakeupRequests.requestedAt));
  return new Map(rows.flatMap(row => row.reason && row.sourceRunId && row.sourceRunId === row.latestRunId
    ? [[row.issueId, row.reason] as const] : []));
}
