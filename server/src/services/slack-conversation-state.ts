import { chatConversations, issues, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

/** Read-only projection; Slack threads do not acquire Agent Chat identities. */
export function externalConversationStateSql() {
  return sql<"active" | "waiting" | null>`(
    select case when c.state = 'waiting' and "issues"."status" = 'in_review'
      and "issues"."execution_run_id" is null
      and "issues"."monitor_next_check_at" is null
      and coalesce("issues"."execution_state"->>'status', '') not in ('pending', 'changes_requested')
      and coalesce("issues"."execution_state"->'monitor'->>'status', '') not in ('scheduled', 'triggered')
      and not exists (select 1 from issue_thread_interactions i
        where i.company_id = c.company_id and i.issue_id = c.issue_id and i.status = 'pending')
      and not exists (select 1 from issue_approvals ia join approvals a on a.id = ia.approval_id and a.company_id = ia.company_id
        where ia.company_id = c.company_id and ia.issue_id = c.issue_id and a.status in ('pending', 'revision_requested'))
      and not exists (select 1 from chat_publications p
        where p.company_id = c.company_id and p.conversation_id = c.id
          and p.state in ('pending', 'streaming', 'retry', 'delivery_unknown', 'failed', 'awaiting_consent'))
      and not exists (select 1 from heartbeat_runs r where r.company_id = c.company_id
        and coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text) = c.issue_id::text
        and r.status in ('queued', 'running', 'scheduled_retry'))
      and not exists (select 1 from agent_wakeup_requests w where w.company_id = c.company_id
        and coalesce(w.payload->>'issueId', w.payload->>'taskId', w.payload->'_paperclipWakeContext'->>'issueId') = c.issue_id::text
        and w.status in ('queued', 'claimed', 'deferred_issue_execution')
        and not exists (select 1 from heartbeat_runs owner where owner.id = w.run_id
          and owner.company_id = w.company_id and owner.status = 'succeeded'))
      and not exists (select 1 from agent_task_sessions session where session.company_id = c.company_id
        and session.task_key = c.issue_id::text and session.goal_status is not null and session.goal_status <> 'complete')
      and not exists (select 1 from issue_relations edge join issues blocker on blocker.id = edge.issue_id and blocker.company_id = edge.company_id
        where edge.company_id = c.company_id and edge.related_issue_id = c.issue_id and edge.type = 'blocks' and blocker.status <> 'done')
      then 'waiting' else 'active' end
    from chat_conversations c join chat_endpoints e on e.id = c.endpoint_id and e.company_id = c.company_id
    where c.company_id = "issues"."company_id" and c.issue_id = "issues"."id"
      and e.provider = 'slack' and e.assigned_agent_id = "issues"."assignee_agent_id"
      and e.status in ('active', 'verifying') and c.state in ('active', 'waiting')
    order by c.created_at desc, c.id desc limit 1
  )`;
}

export function nonIdleSlackIssueCondition() {
  return sql`${externalConversationStateSql()} is distinct from 'waiting'`;
}

/** Called inside message admission while its transaction owns the issue lock. */
export async function resumeSlackConversation(tx: Db, companyId: string, issueId: string) {
  // Only the verified idle convention may leave In Review automatically.
  // A real decision or delivery problem keeps the existing review semantics.
  await tx.update(issues).set({ status: "todo", updatedAt: new Date() })
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId),
      sql`${externalConversationStateSql()} = 'waiting'`));
  await tx.update(chatConversations).set({ state: "active", updatedAt: new Date() })
    .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId),
      eq(chatConversations.state, "waiting"), sql`exists (select 1 from chat_endpoints e
        where e.id = ${chatConversations.endpointId} and e.company_id = ${chatConversations.companyId} and e.provider = 'slack')`));
}
