import { sql } from "drizzle-orm";
import { issues } from "@paperclipai/db";

/** Tasks whose own rows changed since `since`, for the backstop between full
 * passes. An assignee agent's row counts only for a change that can make its
 * tasks need recovery (a pause, resume, hold or configuration change). Run
 * lifecycle writes are left out: a run's finish records a heartbeat, and a run's
 * start flips the agent to running, which makes none of its other tasks
 * stranded. Every run start would otherwise re-check all of the agent's tasks
 * for two backstop windows. */
export function changedTaskCondition(since: Date) {
  const at = sql`${since.toISOString()}::timestamptz`;
  return sql`(${issues.updatedAt} >= ${at}
    or exists (select 1 from heartbeat_runs r where r.company_id = ${issues.companyId}
      and (r.context_snapshot->>'issueId') = ${issues.id}::text and r.updated_at >= ${at})
    or exists (select 1 from issue_recovery_actions a where a.company_id = ${issues.companyId}
      and a.source_issue_id = ${issues.id} and a.updated_at >= ${at})
    or exists (select 1 from agent_wakeup_requests w where w.company_id = ${issues.companyId}
      and (w.payload->>'issueId') = ${issues.id}::text and w.updated_at >= ${at})
    or exists (select 1 from issue_thread_interactions t where t.company_id = ${issues.companyId}
      and t.issue_id = ${issues.id} and t.updated_at >= ${at})
    or exists (select 1 from issue_comments c where c.company_id = ${issues.companyId}
      and c.issue_id = ${issues.id} and c.created_at >= ${at})
    or exists (select 1 from agents ag where ag.id = ${issues.assigneeAgentId} and ag.updated_at >= ${at}
      and ag.status <> 'running'
      and (ag.last_heartbeat_at is null or ag.last_heartbeat_at < ag.updated_at)))`;
}
