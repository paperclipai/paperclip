import { decideDeferredWakeOwnership } from "../domain/policy.js";
import { readNonEmptyString } from "../domain/values.js";
import type { DeferredWakeCandidate, IssueSnapshot } from "./ports.js";

/**
 * True when the deferred wake belongs to an agent that no longer owns the
 * issue, by the same rule run dispatch applies before it cancels a queued run
 * as `issue_assignee_changed`.
 */
export function isFormerOwnerDeferredWake(issue: IssueSnapshot, candidate: DeferredWakeCandidate): boolean {
  const participant = issue.executionState?.currentParticipant as Record<string, unknown> | null | undefined;
  const reviewParticipantAgentId = participant?.type === "agent" ? readNonEmptyString(participant.agentId) : null;
  return decideDeferredWakeOwnership({
    requiresIssueOwnership: candidate.requiresIssueOwnership === true,
    hasIndependentAuthority: candidate.authorizedFailedChatRetry === true || candidate.payload.mutation === "interaction",
    issueIsTerminal: issue.status === "done" || issue.status === "cancelled",
    wakeAgentIsAssignee: candidate.agentId === issue.assigneeAgentId,
    wakeAgentIsReviewParticipant: issue.status === "in_review" && reviewParticipantAgentId === candidate.agentId,
  }) === "former_owner";
}
