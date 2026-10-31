import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyUnsafeWorkspaceExportRecovery } from "./unsafe-workspace-export-notifications.js";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { chatConversations, chatEndpoints, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export type ExternalConversationSettlementScope = { companyId: string; issueId?: string };



async function readSettlement(db: Pick<Db, "select" | "execute">, companyId: string, issueId: string, lock = false) {


  const bindingQuery = db.select({ conversation: { id: chatConversations.id, state: chatConversations.state },
    endpoint: { provider: chatEndpoints.provider, assignedAgentId: chatEndpoints.assignedAgentId } })
    .from(chatConversations)
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId), eq(chatEndpoints.companyId, chatConversations.companyId)))
    .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId),
      sql`(${chatEndpoints.provider} = 'slack' or (${chatEndpoints.provider} = 'speko' and exists
        (select 1 from issues owned where owned.id = ${chatConversations.issueId} and owned.company_id = ${chatConversations.companyId}
          and owned.origin_id = ${chatEndpoints.id}::text)))`, inArray(chatConversations.state, ["active", "waiting"]),
      inArray(chatEndpoints.status, ["active", "verifying"])))
    .orderBy(desc(chatConversations.createdAt)).limit(1);
  const [binding] = await (lock ? bindingQuery.for("update", { of: chatEndpoints }) : bindingQuery);
  if (!binding || binding.conversation.state !== "active") return null;
  const issueQuery = db.select({ id: issues.id, title: issues.title, identifier: issues.identifier,
    originKind: issues.originKind, conversationAgentId: issues.conversationAgentId, hiddenAt: issues.hiddenAt,
    assigneeUserId: issues.assigneeUserId, assigneeAgentId: issues.assigneeAgentId, status: issues.status,
    executionRunId: issues.executionRunId, monitorNextCheckAt: issues.monitorNextCheckAt,
    executionState: issues.executionState }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  const [issue] = await (lock ? issueQuery.for("update") : issueQuery);
  if (!issue || issue.originKind !== "chat_channel" || issue.conversationAgentId || issue.hiddenAt ||
    issue.assigneeUserId || issue.assigneeAgentId !== binding.endpoint.assignedAgentId ||
    issue.status !== "in_progress" || issue.executionRunId || issue.monitorNextCheckAt ||
    ["pending", "changes_requested"].includes(String(issue.executionState?.status))) return null;
  const monitor = issue.executionState?.monitor;
  if (monitor && typeof monitor === "object" && "status" in monitor &&
    ["scheduled", "triggered"].includes(String(monitor.status))) return null;
  const [run] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
    finishedAt: heartbeatRuns.finishedAt, scheduledRetryAt: heartbeatRuns.scheduledRetryAt, livenessState: heartbeatRuns.livenessState,
    runtimeMode: heartbeatRuns.runtimeMode, resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId),
      sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId', ${heartbeatRuns.nativeIssueId}::text) = ${issueId}`))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!run || run.status !== "succeeded" || run.agentId !== issue.assigneeAgentId ||
    !run.finishedAt ||
    run.scheduledRetryAt || ["plan_only", "empty_response"].includes(run.livenessState ?? "")) return null;
  if (run.runtimeMode === "native" && run.resultJson?.finalizationReasonCode !== "external_chat_response_waiting") return null;



  const context = run.contextSnapshot ?? {};
  const commentIds = [...new Set([
    context.wakeCommentId, context.commentId,
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
  ].filter((id): id is string => typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id)))];
  if (!commentIds.length) return null;
  const [wake] = await db.select({ id: issueComments.id }).from(issueComments)
    .where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, commentIds)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (!wake) return null;
  const [evidence] = await db.execute<{ ready: boolean }>(sql`select
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
  if (!evidence?.ready) return null;
  return { binding, issue, run };
}


export async function pendingExternalConversationSettlement(db: Db, companyId: string, issueId: string) {
  return Boolean(await readSettlement(db, companyId, issueId));
}



export function externalConversationSettlementCandidates(db: Db, scope?: ExternalConversationSettlementScope, after?: string) {
  return db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
    eq(issues.originKind, "chat_channel"), eq(issues.status, "in_progress"),
    isNull(issues.hiddenAt), isNull(issues.conversationAgentId), isNull(issues.assigneeUserId),
    scope ? eq(issues.companyId, scope.companyId) : undefined,
    scope?.issueId ? eq(issues.id, scope.issueId) : undefined,
    after ? gt(issues.id, after) : undefined,
    sql`exists (select 1 from chat_conversations c where c.company_id = ${issues.companyId}
      and c.issue_id = ${issues.id} and c.state = 'active')`,
  )).orderBy(asc(issues.id)).limit(100);
}

/** Both run finalization and provider publication can arrive first. Re-read
 * durable evidence under the task lock; never infer completion from prose. */
export async function settleExternalConversation(db: Db, companyId: string, issueId: string): Promise<boolean> {
  let activity: ActivityPublication | null = null;
  const settled = await db.transaction(async (tx) => {
    const ready = await readSettlement(tx, companyId, issueId, true);
    if (!ready) return false;
    const { binding, issue, run } = ready;
    const changed = await tx.update(chatConversations).set({ state: "waiting", updatedAt: new Date() })
      .where(and(eq(chatConversations.id, binding.conversation.id), eq(chatConversations.companyId, companyId), eq(chatConversations.state, "active")))
      .returning({ id: chatConversations.id });
    if (!changed.length) return false;
    await notifyUnsafeWorkspaceExportRecovery(tx, { companyId, issueId });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
    await tx.update(issues).set({ status: "in_review", updatedAt: new Date() })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
    activity = (await persistActivity(tx as unknown as Db, {
      companyId, actorType: "system", actorId: `${binding.endpoint.provider}-conversation`, action: "issue.updated",
      entityType: "issue", entityId: issueId, runId: run.id,
      details: { status: "in_review", externalConversationState: "waiting", conversationId: binding.conversation.id,
        issueTitle: issue.title, issueIdentifier: issue.identifier },
    })).publication;
    return true;
  });
  if (activity) publishActivity(activity);
  return settled;
}

/** Compatibility name for existing Slack callers. */
export const settleSlackConversation = settleExternalConversation;
