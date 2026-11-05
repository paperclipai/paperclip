import { isPaperclipExternalChatContractTurn, normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";
import type { CaseExecutionContext, projectCaseContinuation } from "../case-context.js";
import { caseInstructionAlreadyRepresented } from "../case-context.js";

/** Only new, authorized events belong in an already retained provider conversation.
 * Full bootstrap input is kept separately for an actual provider resume failure.
 */
export function buildNativeContinuationPrompt(input: {
  wakePayload: unknown;
  previousRunId: string;
  issue: { title: string; description: string | null };
  previousIssue: { title: string; description: string | null };
  /** The constructor opts complete plain-text chat batches into the resume protocol. */
  allowExternalChat?: boolean;
  caseContext?: CaseExecutionContext | null;
  workflowCase?: ReturnType<typeof projectCaseContinuation>;
  previousGitHubReviewConfigurationKeys?: readonly string[];
}): string | null {
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const continuation = wake?.executionContinuation;
  const delta = continuation?.resumeDelta;
  if (!wake || !delta || delta.baseRunId !== input.previousRunId) return null;
  if (input.caseContext && !input.workflowCase) return null;
  const rawWake = input.wakePayload && typeof input.wakePayload === "object"
    ? input.wakePayload as Record<string, unknown> : {};
  // Attachment descriptors are intentionally omitted by the generic normalizer.
  // Retain the complete bootstrap framing whenever current input needs them or
  // an omission notice. The compact path never guesses an unavailable file.
  const hasAttachmentContext =
    (rawWake.attachmentOmissions != null &&
      (!Array.isArray(rawWake.attachmentOmissions) || rawWake.attachmentOmissions.length > 0)) ||
    (Array.isArray(rawWake.comments) && rawWake.comments.some((comment) =>
      comment && typeof comment === "object" &&
      (comment as Record<string, unknown>).attachments != null &&
      (!Array.isArray((comment as Record<string, unknown>).attachments) ||
        ((comment as Record<string, unknown>).attachments as unknown[]).length > 0)));
  const externalChat = input.allowExternalChat === true &&
    (wake.externalChatProvider === "slack" || wake.externalChatProvider === "github") &&
    isPaperclipExternalChatContractTurn(input.wakePayload) &&
    !hasAttachmentContext && wake.commentIds.length > 0 &&
    wake.latestCommentId === wake.commentIds.at(-1) &&
    new Set(wake.commentIds).size === wake.commentIds.length &&
    wake.commentIds.every((id) => {
      const comments = wake.comments.filter((entry) => entry.id === id);
      const messages = delta.messages.filter((entry) => entry.id === id);
      return comments.length === 1 && messages.length === 1 &&
        messages[0]!.body === comments[0]!.body &&
        messages[0]!.authorType === comments[0]!.authorType &&
        messages[0]!.authorId === comments[0]!.authorId;
    });
  const caseHandoff = wake.reason === "case_handoff" && !!input.workflowCase && !!input.caseContext?.incomingHandoff;
  // Other provider, attachment, question, approval, and recovery paths keep
  // their specialized framing. A matching prior run still gates every delta.
  if (rawWake.chatCompletionUpdates || (wake.externalChatProvider && !externalChat) ||
    (!['issue_commented', 'issue_children_completed'].includes(wake.reason ?? '') && !caseHandoff &&
      !(externalChat && wake.reason === "External chat message received")) ||
    wake.fallbackFetchNeeded || wake.truncated || wake.recovery || continuation?.interruptedRunId ||
    (wake.externalChatExecutionBound && !externalChat) || wake.externalChatQuestionResponse ||
    wake.taskWatchdog || wake.livenessContinuation || wake.activeTreeHold ||
    wake.skillTest || wake.executionStage || wake.agentMessage ||
    wake.documentReviewContext || wake.planReviewContext || wake.annotationDeltas.length > 0
  ) return null;
  const taskChanges = Object.fromEntries(
    (["title", "description"] as const)
      .filter((key) => input.issue[key] !== input.previousIssue[key])
      .map((key) => [key, input.issue[key]]),
  );
  const humanResponses = (continuation?.humanResponses ?? []).filter((answer) => answer.id === wake.interactionId);
  // Do not substitute an unverified interaction outcome for an authorized answer.
  if (wake.interactionId && humanResponses.length === 0) return null;
  const events = {
    ...(wake.githubReviewConfigurations.some((config) => !input.previousGitHubReviewConfigurationKeys?.includes(config.key))
      ? { reviewConfigurations: wake.githubReviewConfigurations.filter((config) => !input.previousGitHubReviewConfigurationKeys?.includes(config.key)) }
      : {}),
    // Only the current authenticated chat delivery belongs to this turn.
    // The generic delta can also include edited historical comments or an old
    // agent response; neither becomes a new provider instruction.
    messages: externalChat
      ? wake.commentIds.map((id) => delta.messages.find((message) => message.id === id)!)
      : delta.messages.filter(message => !input.workflowCase || !caseInstructionAlreadyRepresented(input.caseContext, message)),
    ...(input.workflowCase ? { workflowCase: input.workflowCase } : {}),
    ...(humanResponses.length ? { humanResponses } : {}),
    ...(Object.keys(taskChanges).length ? { taskChanges } : {}),
    ...(wake.childIssueSummaries.length ? { childResults: wake.childIssueSummaries } : {}),
    ...(wake.childIssueSummaryTruncated ? { childResultsTruncated: true } : {}),
    ...(wake.unresolvedBlockerIssueIds.length ? { unresolvedBlockerIssueIds: wake.unresolvedBlockerIssueIds } : {}),
  };
  if (!events.messages.length && !humanResponses.length && !wake.childIssueSummaries.length && !Object.keys(taskChanges).length && !input.workflowCase) return null;
  return JSON.stringify(events);
}
