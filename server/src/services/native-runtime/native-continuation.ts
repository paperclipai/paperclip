import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";

/** Only new, authorized events belong in an already retained provider conversation.
 * Full bootstrap input is kept separately for an actual provider resume failure.
 */
export function buildNativeContinuationPrompt(input: {
  wakePayload: unknown;
  previousRunId: string;
  issue: { title: string; description: string | null };
  previousIssue: { title: string; description: string | null };
}): string | null {
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const continuation = wake?.executionContinuation;
  const delta = continuation?.resumeDelta;
  if (!wake || !delta || delta.baseRunId !== input.previousRunId) return null;
  // These paths have specialized delivery/recovery contracts. Preserve their
  // existing framing until they have an event-specific continuation projection.
  if (!['issue_commented', 'issue_children_completed'].includes(wake.reason ?? '') ||
    wake.fallbackFetchNeeded || wake.truncated || wake.recovery || continuation?.interruptedRunId ||
    wake.externalChatExecutionBound || wake.externalChatQuestionResponse ||
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
    messages: delta.messages,
    ...(humanResponses.length ? { humanResponses } : {}),
    ...(Object.keys(taskChanges).length ? { taskChanges } : {}),
    ...(wake.childIssueSummaries.length ? { childResults: wake.childIssueSummaries } : {}),
    ...(wake.childIssueSummaryTruncated ? { childResultsTruncated: true } : {}),
    ...(wake.unresolvedBlockerIssueIds.length ? { unresolvedBlockerIssueIds: wake.unresolvedBlockerIssueIds } : {}),
  };
  if (!events.messages.length && !humanResponses.length && !wake.childIssueSummaries.length && !Object.keys(taskChanges).length) return null;
  return JSON.stringify(events);
}
