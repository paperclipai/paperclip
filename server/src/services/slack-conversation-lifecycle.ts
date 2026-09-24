import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** Both run finalization and provider publication can arrive first. Re-read
 * durable evidence under the task lock; never infer completion from prose. */
export async function settleSlackConversation(db: Db, companyId: string, issueId: string): Promise<boolean> {
  let activity: ActivityPublication | null = null;
  const settled = await db.transaction(async (tx) => {
    // Match chat admission's endpoint -> task lock order. A closed/revoked
    // connection must not be resurrected by a late finalizer.
    const [binding] = await tx.select({ conversation: chatConversations, endpoint: chatEndpoints })
      .from(chatConversations)
      .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, chatConversations.companyId)))
      .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId),
        eq(chatEndpoints.provider, "slack"), inArray(chatConversations.state, ["active", "waiting"]),
        inArray(chatEndpoints.status, ["active", "verifying"])))
      .orderBy(desc(chatConversations.createdAt)).limit(1)
      .for("update", { of: chatEndpoints });
    if (!binding) return false;
    const [issue] = await tx.select().from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
    if (!issue || issue.originKind !== "chat_channel" || issue.conversationAgentId || issue.hiddenAt ||
      issue.assigneeUserId || issue.assigneeAgentId !== binding.endpoint.assignedAgentId ||
      issue.status !== "in_progress" || issue.executionRunId || issue.monitorNextCheckAt ||
      ["pending", "changes_requested"].includes(String(issue.executionState?.status))) return false;
    const monitor = issue.executionState?.monitor;
    if (monitor && typeof monitor === "object" && "status" in monitor &&
      ["scheduled", "triggered"].includes(String(monitor.status))) return false;
    const [run] = await tx.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId', ${heartbeatRuns.nativeIssueId}::text) = ${issueId}`))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (!run || run.status !== "succeeded" || run.agentId !== issue.assigneeAgentId ||
      !run.finishedAt ||
      run.scheduledRetryAt || ["plan_only", "empty_response"].includes(run.livenessState ?? "")) return false;
    if (run.runtimeMode === "native" && run.resultJson?.finalizationReasonCode !== "external_chat_response_waiting") return false;
    // The published, server-selected response is the binding proof. Resolved
    // questions can use an interaction continuation source and a board comment
    // instead of an inbound Slack link; publication already enforced access.
    const context = run.contextSnapshot ?? {};
    const commentIds = [...new Set([
      context.wakeCommentId, context.commentId,
      ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ].filter((id): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)))];
    if (!commentIds.length) return false;
    const [wake] = await tx.select().from(issueComments)
      .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, commentIds)))
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
    if (!wake) return false;
    const [evidence] = await tx.execute<{ ready: boolean }>(sql`select
      exists (select 1 from chat_publications p join issue_comments response
        on response.id = p.comment_id and response.company_id = p.company_id and response.issue_id = p.issue_id
        where p.company_id = ${companyId} and p.issue_id = ${issueId} and p.conversation_id = ${binding.conversation.id}
          and p.state = 'published' and p.provider_message_id is not null
          and response.created_by_run_id = ${run.id} and response.author_agent_id = ${run.agentId}
          and response.deleted_at is null
          and response.created_at >= (select original.created_at from issue_comments original
            where original.company_id = ${companyId} and original.id = ${wake.id})
          and response.metadata->>'authorizationReason' = 'allow_chat_run_presentation')
      and (${run.runtimeMode} <> 'native' or exists (select 1 from native_run_finalizations f
        where f.company_id = ${companyId} and f.issue_id = ${issueId} and f.run_id = ${run.id} and f.phase = 'committed'))
      and not exists (select 1 from agent_task_sessions session where session.company_id = ${companyId}
        and session.task_key = ${issueId} and session.goal_status is not null and session.goal_status <> 'complete')
      and not exists (select 1 from issue_comments newer where newer.company_id = ${companyId} and newer.issue_id = ${issueId}
        and newer.deleted_at is null and newer.author_agent_id is null
        and (coalesce(newer.author_type, 'user') <> 'system' or exists (select 1 from chat_message_links inbound
          where inbound.company_id = newer.company_id and inbound.comment_id = newer.id
            and inbound.conversation_id = ${binding.conversation.id} and inbound.direction = 'inbound'))
        and (newer.created_at, newer.id) > (select original.created_at, original.id from issue_comments original
          where original.company_id = ${companyId} and original.id = ${wake.id}))
      and not exists (select 1 from heartbeat_runs r where r.company_id = ${companyId}
        and coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId', r.native_issue_id::text) = ${issueId}
        and r.status in ('queued', 'running', 'scheduled_retry'))
      and not exists (select 1 from agent_wakeup_requests w where w.company_id = ${companyId}
        and coalesce(w.payload->>'issueId', w.payload->>'taskId', w.payload->'_paperclipWakeContext'->>'issueId') = ${issueId}
        and w.status in ('queued', 'claimed', 'deferred_issue_execution') and w.run_id is distinct from ${run.id}::uuid)
      and not exists (select 1 from issue_thread_interactions i where i.company_id = ${companyId} and i.issue_id = ${issueId} and i.status = 'pending')
      and not exists (select 1 from issue_approvals ia join approvals a on a.id = ia.approval_id and a.company_id = ia.company_id
        where ia.company_id = ${companyId} and ia.issue_id = ${issueId} and a.status in ('pending', 'revision_requested'))
      and not exists (select 1 from issue_relations edge join issues blocker on blocker.id = edge.issue_id and blocker.company_id = edge.company_id
        where edge.company_id = ${companyId} and edge.related_issue_id = ${issueId} and edge.type = 'blocks' and blocker.status <> 'done')
      and not exists (select 1 from chat_publications p where p.company_id = ${companyId} and p.conversation_id = ${binding.conversation.id}
        and p.state in ('pending', 'streaming', 'retry', 'delivery_unknown', 'failed', 'awaiting_consent'))
      as ready`);
    if (!evidence?.ready) return false;
    const changed = await tx.update(chatConversations).set({ state: "waiting", updatedAt: new Date() })
      .where(and(eq(chatConversations.id, binding.conversation.id), eq(chatConversations.companyId, companyId), eq(chatConversations.state, "active")))
      .returning({ id: chatConversations.id });
    if (!changed.length) return false;
    await tx.update(issues).set({ status: "in_review", updatedAt: new Date() })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    activity = (await persistActivity(tx as unknown as Db, {
      companyId, actorType: "system", actorId: "slack-conversation", action: "issue.updated",
      entityType: "issue", entityId: issueId, runId: run.id,
      details: { status: "in_review", externalConversationState: "waiting", conversationId: binding.conversation.id,
        issueTitle: issue.title, issueIdentifier: issue.identifier },
    })).publication;
    return true;
  });
  if (activity) publishActivity(activity);
  return settled;
}
