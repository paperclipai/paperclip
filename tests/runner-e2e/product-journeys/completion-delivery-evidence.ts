import { completionDelivery, type CompletionObservation } from "../completion-updates.js";
import { hireRunIssueId } from "./hire-delegate-evidence.js";

type Row = Record<string, any>;
export interface CompletionScope {
  companyId: string; sourceId: string; userId: string; leadId: string; workerAgentId: string;
  projectId: string; taskTitle: string; provider: string; model: string; environmentId: string;
}
export function completionTaskCreationMatches(scope: CompletionScope, task: Row, events: Row[], runs: Row[]) {
  return typeof task.id === "string" && task.id.length > 0 && task.companyId === scope.companyId && task.title === scope.taskTitle && task.projectId === scope.projectId
    && task.assigneeAgentId === scope.workerAgentId && task.createdByAgentId === scope.leadId
    && events.some(event => event.companyId === scope.companyId && event.actorType === "agent"
      && event.actorId === scope.leadId && event.agentId === scope.leadId && event.entityType === "issue" && event.entityId === task.id
      && ["issue.created", "issue.child_created"].includes(event.action)
      && event.details?.assigneeAgentId === scope.workerAgentId && event.details?.assigneeUserId === null && runs.some(run => run.id === event.runId
        && run.companyId === scope.companyId && run.agentId === scope.leadId && hireRunIssueId(run) === scope.sourceId && run.runtimeMode === "native"
        && run.contextSnapshot?.source === "issue.comment" && run.contextSnapshot?.wakeReason !== "chat_task_completed"));
}

/** A promise or a successful lead run cannot substitute for the worker's saved
 * output and the server's callback context. Preserve the prose for human review. */
export function completionJourneyChecks(scope: CompletionScope, observation: CompletionObservation, input: {
  request: string; expectedBody: string; revisions: Row[]; events: Row[];
}) {
  const { worker, runs, comments, documents } = observation;
  const boundRuns = runs.length === 3 && new Set(runs.map(run => run.id)).size === 3
    && runs.every(run => run.companyId === scope.companyId && run.status === "succeeded" && run.runtimeMode === "native"
      && run.contextSnapshot?.paperclipEnvironment?.id === scope.environmentId
      && run.runnerProfileJson?.nativeExecutionInput?.provider?.kind === scope.provider
      && run.runnerProfileJson?.nativeExecutionInput?.provider?.model === scope.model
      && (run.agentId === scope.leadId && hireRunIssueId(run) === scope.sourceId
        || run.agentId === scope.workerAgentId && hireRunIssueId(run) === worker.id));
  const lead = runs.filter(run => run.agentId === scope.leadId), work = runs.filter(run => run.agentId === scope.workerAgentId);
  const userComments = comments.filter(comment => comment.authorUserId);
  const userOnce = userComments.length === 1 && userComments[0]?.authorUserId === scope.userId
    && userComments[0]?.companyId === scope.companyId && userComments[0]?.issueId === scope.sourceId
    && userComments[0]?.body === input.request;
  const requested = lead.filter(run => run.contextSnapshot?.wakeReason !== "chat_task_completed");
  const callbacks = lead.filter(run => run.contextSnapshot?.wakeReason === "chat_task_completed");
  const callback = callbacks[0], context = callback?.contextSnapshot;
  const turns = lead.length === 2 && work.length === 1 && requested.length === 1 && callbacks.length === 1 && userOnce
    && requested[0]?.contextSnapshot?.source === "issue.comment"
    && requested[0]?.contextSnapshot?.wakeCommentId === userComments[0]?.id
    && callback?.invocationSource === "automation" && callback?.triggerDetail === "system"
    && context?.wakeSource === "automation" && context?.wakeTriggerDetail === "system" && !context?.wakeCommentId
    && context?.chatCompletionDeliveryIds?.length === 1 && typeof context.chatCompletionDeliveryIds[0] === "string"
    && context.chatCompletionDeliveryIds[0].length > 0 && context?.chatCompletionUpdates?.length === 1
    && context.chatCompletionUpdates[0]?.id === worker.id && context.chatCompletionUpdates[0]?.status === "done";
  const output = documents.filter(document => document.companyId === scope.companyId && document.issueId === worker.id
    && document.key === "completion-brief" && typeof document.body === "string" && document.body.trim() === input.expectedBody);
  const latest = input.revisions.find(revision => revision.id === output[0]?.latestRevisionId);
  const authored = output.length === 1 && latest?.body === output[0]?.body
    && !latest?.createdByUserId && latest?.createdByAgentId === scope.workerAgentId && work.some(run => run.id === latest.createdByRunId);
  const delivered = completionDelivery(observation);
  return [
    { id: "completion-delegated-task-attributed", passed: completionTaskCreationMatches(scope, worker, input.events, runs) },
    { id: "completion-worker-output-attributed", passed: authored },
    { id: "completion-one-user-request", passed: userOnce
      && delivered.responses.every(comment => comment.companyId === scope.companyId && comment.issueId === scope.sourceId
        && comment.authorAgentId === scope.leadId && !comment.authorUserId) },
    { id: "completion-three-bound-turns", passed: Boolean(boundRuns && turns) },
    ...delivered.checks.map(({ id, passed }) => ({ id, passed })),
  ];
}
