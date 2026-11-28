export type ConversationIdentity = {
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  conversationState?: string | null;
  status?: string;
};
export function isConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return Boolean(issue?.conversationAgentId && issue.conversationUserId);
}
export function isWaitingConversation(
  issue: ConversationIdentity | null | undefined,
): boolean {
  return (
    isConversation(issue) &&
    issue?.conversationState === "waiting" &&
    issue.status === "in_review"
  );
}

export function isConversationExecutionWake(
  issue: ConversationIdentity | null | undefined,
  reason: string | null | undefined,
): boolean {
  return isConversation(issue) && (
    reason === "issue_blockers_resolved" ||
    reason === "issue_children_completed" ||
    reason === "issue_blocker_stalled" ||
    reason === "issue_unblock_requested"
  );
}

export function canActorRetryConversation(issue: ConversationIdentity, actorId: string): boolean {
  return !issue.conversationAgentId || issue.conversationUserId === actorId;
}
