import { sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";

export async function taskRetryRunAncestry(input: {
  db: Db; companyId: string; issueId: string; agentId: string; sourceRunId: string;
}): Promise<string[] | null> {
  const rows = await input.db.execute<{ id: string | null; status: string | null; valid: boolean; cycle: boolean; depth: number }>(sql`
    with recursive ancestry as (
      select r.id, r.status, r.retry_of_run_id, r.created_at, array[r.id] as path, false as cycle, 1 as depth,
        (r.agent_id = ${input.agentId}::uuid and r.finished_at is not null
          and r.status in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded')
          and (r.native_issue_id is null or r.native_issue_id::text = ${input.issueId})
          and (r.issue_id is null or r.issue_id::text = ${input.issueId})
          and coalesce(r.native_issue_id::text, r.issue_id::text, r.context_snapshot->>'issueId') = ${input.issueId}) as valid
      from ${heartbeatRuns} r
      where r.company_id = ${input.companyId} and r.id = ${input.sourceRunId}::uuid
      union all
      select predecessor.id, predecessor.status, predecessor.retry_of_run_id, predecessor.created_at,
        current.path || predecessor.id, coalesce(predecessor.id = any(current.path), false), current.depth + 1,
        (predecessor.id is not null and predecessor.agent_id = ${input.agentId}::uuid
          and predecessor.finished_at is not null
          and predecessor.status in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded')
          and (predecessor.native_issue_id is null or predecessor.native_issue_id::text = ${input.issueId})
          and (predecessor.issue_id is null or predecessor.issue_id::text = ${input.issueId})
          and coalesce(predecessor.native_issue_id::text, predecessor.issue_id::text,
            predecessor.context_snapshot->>'issueId') = ${input.issueId})
      from ancestry current
      left join ${heartbeatRuns} predecessor on predecessor.id = current.retry_of_run_id
        and predecessor.company_id = ${input.companyId} and predecessor.created_at <= current.created_at
      where current.retry_of_run_id is not null and current.valid and not current.cycle and current.depth <= 32
    ) select id, status, valid, cycle, depth from ancestry
  `);
  if (!rows.length || rows.some(row => !row.id || row.valid !== true || row.cycle || row.depth > 32)) return null;
  return rows.filter(row => row.id === input.sourceRunId || row.status !== "succeeded").map(row => row.id!);
}

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
