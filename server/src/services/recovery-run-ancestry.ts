import { sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";

/** Only committed predecessor edges can carry preserved work into a retry. */
export async function recoveryRunAncestry(input: {
  db: Db; companyId: string; issueId: string; sourceRunIds: string[];
}) {
  // Follow committed predecessor receipts, not transcript paths. UNION makes
  // cycles and duplicate receipts finite; every edge retains company/task scope.
  return input.db.execute<{ id: string }>(sql`
    with recursive sources(id) as (
      select r.id from ${heartbeatRuns} r
      where r.company_id = ${input.companyId}
        and coalesce(r.native_issue_id::text, r.issue_id::text, r.context_snapshot->>'issueId') = ${input.issueId}
        and r.id in (select ${canonicalExecutionUuid(sql`value`)}
          from jsonb_array_elements_text(${JSON.stringify(input.sourceRunIds)}::jsonb))
      union
      select predecessor.id from sources s
      join ${heartbeatRuns} current_run on current_run.id = s.id
      cross join lateral (
        select current_run.retry_of_run_id::text as id
        union
        select w.payload#>>'{taskRetry,sourceRunId}' from ${agentWakeupRequests} w
        where w.company_id = ${input.companyId} and w.run_id = s.id
          and w.reason = 'task_retry' and w.status = 'coalesced'
          and w.requested_by_actor_type = 'user' and w.payload->>'issueId' = ${input.issueId}
          and w.payload#>>'{taskRetry,schema}' = 'paperclip.task-retry.v1'
          and w.payload#>>'{taskRetry,generationId}' = w.id::text
        union
        select a.evidence->>'runId' from ${issueRecoveryActions} a
        where a.company_id = ${input.companyId} and a.source_issue_id = ${input.issueId}
          and a.evidence#>>'{explicitUserContinuation,runId}' = s.id::text
      ) edge
      join ${heartbeatRuns} predecessor on predecessor.id = ${canonicalExecutionUuid(sql`edge.id`)}
        and predecessor.company_id = ${input.companyId}
        and coalesce(predecessor.native_issue_id::text, predecessor.issue_id::text,
          predecessor.context_snapshot->>'issueId') = ${input.issueId}
    ) select id from sources
  `);
}
