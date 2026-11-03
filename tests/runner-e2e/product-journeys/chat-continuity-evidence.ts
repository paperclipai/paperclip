import { chatMarker } from "../chat-cases.js";
import { taskReplyBelongsToRun, type TaskReplyObservation } from "../native-task-reply.js";

type Row = Record<string, any>;
export const CHAT_CONTINUITY_CHECKS = [
  "chat-fresh-owned-conversation", "chat-user-messages-stored-once", "chat-reload-preserved-context",
  "chat-new-session-boundary", "chat-fresh-context-answer", "chat-history-preserved-after-reload",
  "chat-no-unrequested-work", "chat-exact-turn-accounting", "configured-model-and-environment",
] as const;

export function chatContinuityScenario(campaignId: string) {
  const remembered = chatMarker("OLDCONTEXT", campaignId), marker = chatMarker("CHAT", campaignId);
  return {
    remembered, marker,
    remember: `For this conversation only, remember the phrase ${remembered}. Just acknowledge briefly; no project or task is needed.`,
    recall: "What phrase did I just ask you to remember? Reply with the phrase only. No project or task is needed.",
    reset: "/new",
    fresh: `Without reading older history or files, if you have a remembered phrase in your current context return it; otherwise reply exactly ${marker}. Do not look it up. No project or task is needed.`,
  };
}

export interface ChatContinuityScope {
  companyId: string; userId: string; agentId: string; agentName: string;
  environmentId: string; provider: string; model: string; campaignId: string;
  agentHistory?: { source: "company-agent-runs"; companyId: string; agentId: string; limit: 1; runIds: string[]; observedBeforeSend: true };
}
export interface ChatContinuityResetReceipt {
  source: "issue-runs"; companyId: string; issueId: string;
  runId: string; agentId: string; status: string; contextIssueId: string; wakeCommentId: string;
  resultJson: { conversationReset: true };
}
export interface ChatContinuityPoint {
  phase: "initial" | "returned" | "recalled" | "reset" | "fresh" | "reopened";
  chat: Row; runs: Row[]; comments: Row[]; tasks: Row[]; activity: Row[];
  reply?: TaskReplyObservation & { runId: string; agentId: string; observedAfterReload: boolean };
  events?: Row[];
  resetReceipts: ChatContinuityResetReceipt[];
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export const chatContinuityResetRun = (run: Row) => run.contextSnapshot?.conversationReset === true || run.resultJson?.conversationReset === true;
export const chatContinuityIssueId = (run: Row): string | undefined => {
  const ids = [run.issueId, run.nativeIssueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].filter(nonempty);
  return ids.length && new Set(ids).size === 1 ? ids[0] : undefined;
};
const userBody = (row: Row) => typeof row.body === "string" ? row.body.replaceAll("\\_", "_").trim() : "";
const sameIds = (left: Row[], right: Row[]) => left.length === right.length && left.every(row => right.some(other => row.id === other.id));
const commentContent = (row: Row) => [row.id, row.companyId, row.issueId, row.body, row.authorAgentId,
  row.authorUserId, row.createdByRunId, row.conversationSessionGeneration];
const sameRows = (left: Row[], right: Row[]) => left.every(row => right.some(other => other.id === row.id
  && JSON.stringify(commentContent(other)) === JSON.stringify(commentContent(row))));

export function chatContinuityActivityComplete(scope: Pick<ChatContinuityScope, "companyId" | "agentId">, rows: Row[]): boolean {
  return Array.isArray(rows) && rows.length < 500 && new Set(rows.map(row => row?.id)).size === rows.length
    && rows.every(row => row && nonempty(row.id) && row.companyId === scope.companyId && row.agentId === scope.agentId
      && nonempty(row.action) && nonempty(row.entityType) && nonempty(row.entityId));
}

export function chatContinuityResetReceiptMatches(scope: Pick<ChatContinuityScope, "companyId" | "agentId">,
  chatId: string, run: Row, receipt: ChatContinuityResetReceipt): boolean {
  const fullResult = run.resultJson;
  const optionalFlagValid = fullResult == null || typeof fullResult === "object" && !Array.isArray(fullResult)
    && (!Object.hasOwn(fullResult, "conversationReset") || fullResult.conversationReset === true);
  return receipt?.source === "issue-runs" && receipt.companyId === scope.companyId && receipt.issueId === chatId
    && receipt.runId === run.id && receipt.agentId === scope.agentId && receipt.status === "succeeded"
    && receipt.contextIssueId === chatId && nonempty(receipt.wakeCommentId)
    && receipt.wakeCommentId === run.contextSnapshot?.wakeCommentId && receipt.resultJson?.conversationReset === true
    && run.companyId === scope.companyId && run.agentId === scope.agentId && chatContinuityIssueId(run) === chatId
    && run.status === "succeeded" && run.contextSnapshot?.conversationReset === true && optionalFlagValid
    && !run.runnerProfileJson?.nativeExecutionInput && !run.nativeSessionId;
}

export function gradeChatContinuity(scope: ChatContinuityScope, points: ChatContinuityPoint[]) {
  const scenario = chatContinuityScenario(scope.campaignId);
  const phases = ["initial", "returned", "recalled", "reset", "fresh", "reopened"] as const;
  const complete = points.length === phases.length && points.every((point, index) => point?.phase === phases[index]
    && point.chat && [point.runs, point.comments, point.tasks, point.activity, point.resetReceipts].every(rows => Array.isArray(rows)
      && rows.every(row => row && typeof row === "object" && !Array.isArray(row))));
  if (!complete) return CHAT_CONTINUITY_CHECKS.map(id => ({ id, passed: false }));
  const [initial, returned, recalled, reset, fresh, reopened] = complete ? points : [];
  const chatId = initial?.chat?.id;
  const scoped = complete && [scope.companyId, scope.userId, scope.agentId, scope.agentName, scope.environmentId,
    scope.provider, scope.model, scope.campaignId].every(nonempty) && nonempty(chatId)
    && scope.agentHistory?.source === "company-agent-runs" && scope.agentHistory.companyId === scope.companyId
    && scope.agentHistory.agentId === scope.agentId && scope.agentHistory.limit === 1 && scope.agentHistory.observedBeforeSend === true
    && Array.isArray(scope.agentHistory.runIds) && scope.agentHistory.runIds.length === 0
    && points.every(point => point.chat?.id === chatId && point.chat.companyId === scope.companyId
      && point.chat.assigneeAgentId === scope.agentId && point.chat.conversationAgentId === scope.agentId
      && point.chat.conversationUserId === scope.userId && point.chat.createdByUserId === scope.userId
      && point.chat.title === `Chat with ${scope.agentName}` && point.chat.status === "in_review"
      && point.chat.conversationState === "waiting" && !point.chat.executionRunId && !point.chat.scheduledRetry && !point.chat.activeRecoveryAction);
  const requested = [scenario.remember, scenario.recall, scenario.reset, scenario.fresh];
  const finalComments = reopened?.comments ?? [];
  const board = finalComments.filter(row => row.authorUserId === scope.userId && !row.authorAgentId);
  const userMessages = scoped && board.length === requested.length && new Set(board.map(row => row.id)).size === requested.length
    && requested.every(body => board.filter(row => userBody(row) === body && row.companyId === scope.companyId && row.issueId === chatId).length === 1)
    && finalComments.every(row => !row.authorUserId || row.authorUserId === scope.userId);
  const runs = reopened?.runs ?? [], providerRuns = runs.filter(run => !chatContinuityResetRun(run)), resetRuns = runs.filter(chatContinuityResetRun);
  const runBinding = scoped && points.every(point => point.runs.every(run => nonempty(run.id) && run.companyId === scope.companyId
    && run.agentId === scope.agentId && chatContinuityIssueId(run) === chatId && run.status === "succeeded"));
  const providerBinding = runBinding && providerRuns.length === 3 && points.flatMap(point => point.runs)
    .filter(run => !chatContinuityResetRun(run)).every(run => {
    const provider = run.runnerProfileJson?.nativeExecutionInput?.provider;
    return run.runtimeMode === "native" && provider?.kind === scope.provider && provider?.model === scope.model
      && run.contextSnapshot?.paperclipEnvironment?.id === scope.environmentId
      && run.nativePhase === "committed"
      && nonempty(run.nativeSessionId);
  });
  const expectedCounts = [1, 1, 2, 3, 4, 4];
  const exactTurns = runBinding && providerBinding && resetRuns.length === 1 && runs.length === 4 && new Set(runs.map(run => run.id)).size === 4
    && points.every(point => point.resetReceipts.length === point.runs.filter(chatContinuityResetRun).length
      && point.runs.filter(chatContinuityResetRun).every(run => point.resetReceipts
        .filter(receipt => chatContinuityResetReceiptMatches(scope, chatId, run, receipt)).length === 1))
    && points.every((point, index) => point.runs.length === expectedCounts[index]
      && point.runs.every(run => runs.some(final => final.id === run.id && final.status === run.status)))
    && runs.every(run => {
      const request = board.find(comment => comment.id === run.contextSnapshot?.wakeCommentId);
      return request && run.contextSnapshot?.source === "issue.comment"
        && (chatContinuityResetRun(run) ? userBody(request) === scenario.reset : userBody(request) !== scenario.reset);
    }) && new Set(runs.map(run => run.contextSnapshot?.wakeCommentId)).size === 4;
  const pointReply = (point: ChatContinuityPoint | undefined) => {
    const receipt = point?.reply, run = point?.runs.find(run => run.id === receipt?.runId);
    return receipt && run && receipt.agentId === scope.agentId && receipt.observedAfterReload === true
      && taskReplyBelongsToRun(receipt, run, scope.agentId, point!.comments, point!.events ?? []) ? receipt : undefined;
  };
  const originalReply = pointReply(initial), returnedReply = pointReply(returned), recalledReply = pointReply(recalled), freshReply = pointReply(fresh), reopenedReply = pointReply(reopened);
  const firstRuns = initial?.runs.filter(run => !chatContinuityResetRun(run)) ?? [];
  const recallRuns = recalled?.runs.filter(run => !chatContinuityResetRun(run) && run.id !== firstRuns[0]?.id) ?? [];
  const freshRuns = fresh?.runs.filter(run => !chatContinuityResetRun(run) && !recalled?.runs.some(old => old.id === run.id)) ?? [];
  const first = firstRuns[0], second = recallRuns[0], last = freshRuns[0], resetRun = resetRuns[0];
  const recall = exactTurns && Boolean(originalReply && returnedReply && recalledReply && originalReply.runId === first?.id
    && returnedReply.runId === originalReply.runId && returnedReply.body === originalReply.body && recalledReply.runId === second?.id
    && recalledReply.body.includes(scenario.remembered) && first?.nativeSessionId === second?.nativeSessionId
    && initial!.chat.conversationSessionGeneration === 0 && returned!.chat.conversationSessionGeneration === 0
    && recalled!.chat.conversationSessionGeneration === 0 && first?.contextSnapshot?.conversationSessionGeneration === 0
    && second?.contextSnapshot?.conversationSessionGeneration === 0 && sameIds(initial!.runs, returned!.runs)
    && sameRows(initial!.comments, returned!.comments));
  const boundary = exactTurns && Boolean(first && second && last && resetRun && freshRuns.length === 1
    && reset!.chat.conversationSessionGeneration === 1 && fresh!.chat.conversationSessionGeneration === 1
    && reopened!.chat.conversationSessionGeneration === 1 && last.contextSnapshot?.conversationSessionGeneration === 1
    && resetRun.contextSnapshot?.conversationSessionGeneration === 1
    && Object.hasOwn(last, "sessionIdBefore") && last.sessionIdBefore === null
    && last.nativeSessionId !== first.nativeSessionId && last.nativeSessionId !== second.nativeSessionId
    && typeof last.contextSnapshot?.paperclipTaskMarkdown === "string"
    && !last.contextSnapshot.paperclipTaskMarkdown.includes(scenario.remembered)
    && finalComments.every(row => row.createdByRunId !== resetRun.id));
  const freshAnswer = boundary && Boolean(freshReply && freshReply.runId === last?.id
    && freshReply.body.trim() === scenario.marker && !freshReply.body.includes(scenario.remembered));
  const history = scoped && Boolean(reopenedReply && freshReply && reopenedReply.runId === freshReply.runId
    && reopenedReply.body === freshReply.body && sameIds(fresh!.runs, reopened!.runs)
    && sameRows(initial!.comments, reopened!.comments) && sameRows(recalled!.comments, reopened!.comments)
    && sameRows(fresh!.comments, reopened!.comments));
  const noWork = scoped && points.every(point => Array.isArray(point.tasks) && point.tasks.length === 0
    && chatContinuityActivityComplete(scope, point.activity)
    && !point.activity.some(row => ["issue.created", "issue.child_created", "project.created", "agent.created", "agent.hire_created"].includes(row.action)));
  const values = [scoped, userMessages, recall, boundary, freshAnswer, history, noWork, exactTurns, providerBinding];
  return CHAT_CONTINUITY_CHECKS.map((id, index) => ({ id, passed: Boolean(values[index]) }));
}
