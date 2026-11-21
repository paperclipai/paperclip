import { unprocessable } from "../errors.js";

/** Check immutable chat identity before stopping a run and again at persistence. */
export function assertConversationIdentityMutationAllowed(
  issue: { conversationAgentId?: string | null },
  patch: Record<string, unknown>,
): void {
  if (!issue.conversationAgentId) return;
  if (
    (patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== issue.conversationAgentId) ||
    patch.assigneeUserId || patch.conversationAgentId !== undefined || patch.conversationUserId !== undefined ||
    patch.conversationState !== undefined || patch.conversationSessionGeneration !== undefined ||
    patch.conversationBoundaryCommentId !== undefined || patch.status === "done" || patch.status === "cancelled"
  ) {
    throw unprocessable("Conversation identity is fixed; finish the reply instead of completing or reassigning the conversation");
  }
}
