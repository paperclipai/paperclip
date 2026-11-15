import { sql } from "drizzle-orm";
import { issues } from "@paperclipai/db";

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
    or exists (select 1 from agents ag where ag.id = ${issues.assigneeAgentId} and ag.updated_at >= ${at}))`;
}
