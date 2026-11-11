import { chatContinuityScenario, type ChatContinuityPoint, type ChatContinuityScope } from "./chat-continuity-evidence.js";

type Row = Record<string, any>;
export function chatContinuityFixture() {
  const scope: ChatContinuityScope = { companyId: "company", userId: "board", agentId: "agent", agentName: "Owned agent",
    environmentId: "environment", provider: "opencode", model: "configured-model", campaignId: "synthetic-continuity-123",
    agentHistory: { source: "company-agent-runs", companyId: "company", agentId: "agent", limit: 1, runIds: [], observedBeforeSend: true } };
  const scenario = chatContinuityScenario(scope.campaignId);
  const user = (id: string, body: string, generation: number) => ({ id, body, authorUserId: scope.userId,
    authorAgentId: null, companyId: scope.companyId, issueId: "chat", conversationSessionGeneration: generation });
  const answer = (id: string, runId: string, body: string, generation: number) => ({ id, body,
    authorAgentId: scope.agentId, authorUserId: null, createdByRunId: runId,
    companyId: scope.companyId, issueId: "chat", conversationSessionGeneration: generation });
  const prompts = [scenario.remember, scenario.recall, scenario.reset, scenario.fresh];
  const board = prompts.map((body, index) => user(`user-${index}`, body, index >= 2 ? 1 : 0));
  const replies = [answer("reply-0", "run-0", "Remembered.", 0), answer("reply-1", "run-1", scenario.remembered, 0),
    answer("reply-3", "run-3", scenario.marker, 1)];
  const run = (index: number): Row => ({ id: `run-${index}`, companyId: scope.companyId, agentId: scope.agentId,
    nativeIssueId: "chat", status: "succeeded", runtimeMode: "native", nativePhase: "committed",
    nativeSessionId: index === 3 ? "new-session" : "original-session", sessionIdBefore: null,
    contextSnapshot: { issueId: "chat", source: "issue.comment", wakeCommentId: board[index]!.id,
      conversationSessionGeneration: index >= 2 ? 1 : 0, paperclipTaskMarkdown: index === 3 ? scenario.fresh : scenario.remember,
      paperclipEnvironment: { id: scope.environmentId } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: scope.provider, model: scope.model } } },
    resultJson: { finalizationPhase: "committed", presentationDecision: { commentId: `reply-${index}` } } });
  const runs = [run(0), run(1), run(2), run(3)];
  runs[2]!.contextSnapshot.conversationReset = true;
  runs[2]!.resultJson = { conversationReset: true };
  delete runs[2]!.runnerProfileJson;
  delete runs[2]!.nativeSessionId;
  delete runs[2]!.nativePhase;
  delete runs[2]!.runtimeMode;
  const chat = { id: "chat", companyId: scope.companyId, assigneeAgentId: scope.agentId, conversationAgentId: scope.agentId,
    conversationUserId: scope.userId, createdByUserId: scope.userId, title: `Chat with ${scope.agentName}`,
    status: "in_review", conversationState: "waiting", conversationSessionGeneration: 0 };
  const comments = [board[0]!, replies[0]!, board[1]!, replies[1]!, board[2]!, board[3]!, replies[2]!];
  const makePoint = (phase: ChatContinuityPoint["phase"], count: number, commentCount: number, generation: number, replyIndex?: number): ChatContinuityPoint => {
    const reply = replyIndex === undefined ? undefined : replies[replyIndex]!;
    return structuredClone({ phase, chat: { ...chat, conversationSessionGeneration: generation }, runs: runs.slice(0, count),
      comments: comments.slice(0, commentCount), tasks: [], activity: [], events: [], resetReceipts: count < 3 ? [] : [{
        source: "issue-runs", companyId: scope.companyId, issueId: "chat", runId: "run-2", agentId: scope.agentId,
        status: "succeeded", contextIssueId: "chat", wakeCommentId: "user-2", resultJson: { conversationReset: true },
      }],
      ...(reply ? { reply: { runId: reply.createdByRunId, agentId: scope.agentId, observedAfterReload: true,
        body: reply.body, anchor: reply.id, visible: true, settled: true, nativeFinal: false } } : {}) });
  };
  const points = [makePoint("initial", 1, 2, 0, 0), makePoint("returned", 1, 2, 0, 0), makePoint("recalled", 2, 4, 0, 1),
    makePoint("reset", 3, 5, 1), makePoint("fresh", 4, 7, 1, 2), makePoint("reopened", 4, 7, 1, 2)];
  return { scope, scenario, points };
}

export function compactChatContinuityFixture() {
  const fixture = chatContinuityFixture();
  for (const point of fixture.points) {
    for (const run of point.runs) run.resultJson = null;
    if (!point.reply) continue;
    point.reply.anchor = `${point.reply.runId}:turn`;
    point.reply.nativeFinal = true;
    point.events = [{ seq: 1, runId: point.reply.runId, companyId: fixture.scope.companyId, agentId: fixture.scope.agentId,
      eventType: "item.completed", protocolSchemaVersion: 1, sourceEventId: "event", sourceInstanceId: "instance", sourceSeq: 1,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: point.reply.runId, sourceKind: "runner",
        eventType: "item.completed", sourceEventId: "event", sourceInstanceId: "instance", sourceSeq: 1,
        payload: { kind: "agentMessage", channel: "final", text: point.reply.body } } } }];
  }
  return fixture;
}
