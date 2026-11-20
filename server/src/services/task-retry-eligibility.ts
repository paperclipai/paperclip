import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";

const UUID_TEXT = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

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
    latestRunId: sql<string | null>`(select latest.id::text from (
      (select run.id, run.created_at from ${heartbeatRuns} run
        where run.company_id = ${companyId}
          and run.issue_id = case when ${agentWakeupRequests.payload}->>'issueId' ~ ${UUID_TEXT}
            then (${agentWakeupRequests.payload}->>'issueId')::uuid end
        order by run.created_at desc, run.id desc limit 1)
      union all
      (select run.id, run.created_at from ${heartbeatRuns} run
        where run.company_id = ${companyId}
          and run.native_issue_id = case when ${agentWakeupRequests.payload}->>'issueId' ~ ${UUID_TEXT}
            then (${agentWakeupRequests.payload}->>'issueId')::uuid end)
      union all
      (select run.id, run.created_at from ${heartbeatRuns} run
        where run.company_id = ${companyId}
          and run.context_snapshot->>'issueId' = ${agentWakeupRequests.payload}->>'issueId'
        order by run.created_at desc, run.id desc limit 1)
    ) latest order by latest.created_at desc, latest.id desc limit 1)` })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), inArray(issueId, issueIds),
      sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' is not null`))
    .orderBy(issueId, desc(agentWakeupRequests.requestedAt));
  return new Map(rows.flatMap(row => row.reason && row.sourceRunId && row.sourceRunId === row.latestRunId
    ? [[row.issueId, row.reason] as const] : []));
}
