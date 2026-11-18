type Row = Record<string, any>;

export interface ChatCompletionEvidence {
  companyId: string;
  agentId: string;
  companyPrefix: string;
  baseURL: string;
  issue: Row;
  child: Row;
  tasks: Row[];
  comments: Row[];
  runEvidence: Array<{ runId: string; events: Row[]; workspaceOperations?: Row[] }>;
  renderedLinks: Array<{ commentId: string; href: string }>;
}

const completionCases = new Set(["multi-repository", "clarify-reuse", "plan-handoff"]);
export function needsChatCompletionProof(suite: string, task: string | undefined, profile?: string, environment?: string) {
  return suite === "agent-chat" && completionCases.has(task ?? "")
    && profile === "runner-codex" && environment === "local";
}

const requireProof = (condition: unknown, code: string) => {
  if (!condition) throw new Error(`Chat completion proof: ${code}`);
};
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const scopeIssue = (run: Row) => run.nativeIssueId ?? run.contextSnapshot?.issueId;
const completionEventTypes = new Set([
  "legacy.case_handoff_cleanup_intent", "lifecycle", "run.startup.reuse", "run.performance.span",
  "native.process_start_requested", "native.process_identity_recorded", "session.resumed",
  "session.capabilities.updated", "session.goal.snapshot", "session.goal.cleared", "harness.diagnostic",
  "provider.notice.recorded", "turn.submitted", "turn.accepted", "turn.started", "turn.completed",
  "item.started", "item.delta", "item.completed", "tool.execution.started", "tool.execution.completed",
  "run.result.proposed", "run.result.accepted", "run.terminal", "instruction_save", "run.presentation.resolved",
]);
const completionItemKinds = new Set([
  "thread_lineage", "model", "goal_cleared", "userMessage", "reasoning", "agentMessage",
  "dynamicToolCall", "verification", "usage",
]);

/** One required delivery is real paid work, not a row to hide from accounting.
 * Only these three isolated native journeys use this independent proof.
 * The catalog total includes this one turn; the caller keeps that bound exact.
 */
export function verifyChatCompletion(runs: readonly Row[], evidence: ChatCompletionEvidence | undefined) {
  requireProof(evidence, "evidence_missing");
  const { companyId, agentId, issue, child, tasks, comments } = evidence!;
  const generation = issue.conversationSessionGeneration;
  requireProof(issue.companyId === companyId && issue.conversationAgentId === agentId
    && Number.isSafeInteger(generation) && generation >= 0, "source_scope");
  requireProof(child.id !== issue.id && child.companyId === companyId && child.status === "done"
    && !child.conversationAgentId && typeof child.assigneeAgentId === "string"
    && Number.isFinite(time(child.completedAt)), "child_done");
  requireProof(tasks.length === 1 && tasks[0]?.id === child.id && tasks[0]?.companyId === companyId, "extra_work");
  requireProof(new Set(runs.map(r => r.id)).size === runs.length && runs.every(r => typeof r.id === "string" && r.id.length > 0 && r.companyId === companyId
    && [issue.id, child.id].includes(scopeIssue(r)) && r.contextSnapshot?.issueId === scopeIssue(r)
    && r.agentId === (scopeIssue(r) === issue.id ? agentId : child.assigneeAgentId)
    && r.runtimeMode === "native" && r.status === "succeeded" && typeof r.nativeSessionId === "string" && r.nativeSessionId.length > 0
    && Number.isFinite(time(r.startedAt)) && Number.isFinite(time(r.processStartedAt))
    && Number.isFinite(time(r.finishedAt)) && time(r.finishedAt) >= time(r.startedAt)
    && r.usageJson?.accountingReceiptReady === true
    && !r.contextSnapshot?.conversationReset && !r.resultJson?.conversationReset), "actual_provider_runs");
  const notifications = runs.filter(r => r.contextSnapshot?.wakeReason === "chat_task_completed"
    || r.contextSnapshot?.chatCompletionDeliveryIds?.length || r.contextSnapshot?.chatCompletionUpdates?.length);
  requireProof(notifications.length === 1, "notification_count");
  const run = notifications[0]!, context = run.contextSnapshot;
  requireProof(scopeIssue(run) === issue.id && run.agentId === agentId
    && run.invocationSource === "automation" && run.triggerDetail === "system"
    && context.wakeReason === "chat_task_completed" && context.wakeSource === "automation"
    && context.conversationSessionGeneration === generation
    && time(run.startedAt) >= time(child.completedAt), "notification_scope");
  requireProof(Array.isArray(context.chatCompletionDeliveryIds) && context.chatCompletionDeliveryIds.length === 1
    && typeof context.chatCompletionDeliveryIds[0] === "string" && context.chatCompletionDeliveryIds[0].length > 0
    && Array.isArray(context.chatCompletionUpdates) && context.chatCompletionUpdates.length === 1, "delivery_count");
  const update = context.chatCompletionUpdates[0];
  requireProof(update.id === child.id && update.status === "done" && update.identifier === child.identifier
    && time(update.completedAt) === time(child.completedAt), "delivery_child");
  const childRuns = runs.filter(r => scopeIssue(r) === child.id);
  requireProof(childRuns.length === 1 && time(childRuns[0]!.startedAt) <= time(child.completedAt), "child_execution");

  const replies = comments.filter(c => c.createdByRunId === run.id);
  requireProof(replies.length === 1, "reply_count");
  const reply = replies[0]!;
  requireProof(reply.companyId === companyId && reply.issueId === issue.id && reply.authorAgentId === agentId
    && reply.authorType === "agent" && !reply.deletedAt
    && (reply.conversationSessionGeneration == null || reply.conversationSessionGeneration === generation)
    && time(reply.createdAt) >= time(run.startedAt) && typeof reply.body === "string" && reply.body.trim(), "reply_scope");
  const link = evidence!.renderedLinks.find(candidate => {
    if (candidate.commentId !== reply.id) return false;
    try {
      const url = new URL(candidate.href, evidence!.baseURL);
      if (url.origin !== new URL(evidence!.baseURL).origin) return false;
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const index = parts.indexOf("issues");
      return (index === 0 || index === 1 && parts[0] === evidence!.companyPrefix)
        && parts.length === index + 2 && [child.id, child.identifier].filter(Boolean).includes(parts[index + 1]);
    } catch { return false; }
  });
  requireProof(link, "rendered_result_access");

  const streams = evidence!.runEvidence.filter(e => e.runId === run.id);
  requireProof(streams.length === 1 && streams[0]!.events.length > 0, "events_missing");
  const stream = streams[0]!;
  requireProof(stream.events.every(e => typeof e.eventType === "string" && e.companyId === companyId && e.runId === run.id && e.agentId === agentId), "event_scope");
  // Native harness work need not use a Paperclip tool. Unknown event types and
  // item kinds (commands, file changes, searches) cannot earn this allowance.
  requireProof(stream.events.every(e => completionEventTypes.has(e.eventType)), "additional_native_work");
  const items = stream.events.filter(e => e.eventType.startsWith("item."));
  for (const event of items) {
    const prp = event.payload?.prpEvent;
    requireProof(prp?.schema === "paperclip.prp.event.v1" && prp.runId === run.id
      && prp.eventType === event.eventType && completionItemKinds.has(prp.payload?.kind), "additional_native_work");
    if (prp.payload.kind !== "dynamicToolCall" && prp.payload.item != null) {
      requireProof(prp.payload.item.type === prp.payload.kind, "additional_native_work");
    }
  }
  requireProof(stream.events.some(e => e.eventType === "run.result.accepted"
    && e.payload?.prpEvent?.schema === "paperclip.prp.event.v1" && e.payload.prpEvent.runId === run.id
    && e.payload.prpEvent.eventType === e.eventType), "accepted_result_missing");
  requireProof(Array.isArray(stream.workspaceOperations) && stream.workspaceOperations.every(o => o.phase === "workspace_finalize"
    && o.heartbeatRunId === run.id && o.companyId === companyId && o.status === "succeeded" && !o.command), "additional_workspace_work");
  const allowedTools = new Set(["get_task", "list_task_documents", "get_task_document", "paperclip_finish"]);
  const tools = stream.events.filter(e => e.eventType.startsWith("tool.execution."));
  const starts = new Map<string, string>(), finishes = new Map<string, string>();
  for (const event of tools) {
    const prp = event.payload?.prpEvent, tool = prp?.payload;
    requireProof(prp?.schema === "paperclip.prp.event.v1" && prp.runId === run.id && prp.eventType === event.eventType
      && tool?.schema === "paperclip.tool.execution.v1" && allowedTools.has(tool.name)
      && typeof tool.executionId === "string" && tool.executionId.length > 0, "additional_tool_work");
    const started = event.eventType === "tool.execution.started";
    requireProof(started || event.eventType === "tool.execution.completed", "tool_outcome");
    requireProof(tool.status === (started ? "running" : "completed"), "tool_outcome");
    const target = started ? starts : finishes;
    requireProof(started || starts.get(tool.executionId) === tool.name, "tool_completion_order");
    requireProof(!target.has(tool.executionId), "duplicate_tool_execution");
    target.set(tool.executionId, tool.name);
  }
  requireProof(starts.size === finishes.size && [...starts].every(([id, name]) => finishes.get(id) === name)
    && [...finishes.values()].filter(name => name === "paperclip_finish").length === 1, "tool_completion");
  for (const event of items) {
    const payload = event.payload.prpEvent.payload;
    if (payload.kind !== "dynamicToolCall") continue;
    const item = payload.item;
    requireProof(item && (event.eventType === "item.started" && item.type === "tool_use"
      && allowedTools.has(item.name) && starts.get(item.id) === item.name
      || event.eventType === "item.completed" && item.type === "tool_result"
      && item.tool_use_id === item.id && finishes.has(item.id)), "unbound_native_tool");
  }
  return { ordinaryProviderRuns: runs.length - 1, totalProviderRuns: runs.length,
    allRunIds: runs.map(r => r.id), notificationRunId: run.id,
    deliveryId: context.chatCompletionDeliveryIds[0] as string, childId: child.id as string,
    replyId: reply.id as string, renderedResultHref: link!.href };
}
