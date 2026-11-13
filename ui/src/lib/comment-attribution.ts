import { responsibleUserLabel } from "@paperclipai/shared";

/**
 * Decide whether an agent comment needs a "for {user}" attribution chip, and
 * what name it should carry (the open cross-task write design (attribution)).
 *
 * Cross-issue agent writes are open by default, so a thread can hold comments
 * from agents that do not own the task. Those are the ones worth marking: for the
 * assignee's own comments the responsible user is already implied by the task's
 * own attribution, and chipping every bubble would be noise.
 */
export function resolveCommentAttribution(input: {
  /** Author agent, or null for human/system comments. */
  authorAgentId: string | null;
  /** Responsible user persisted for the comment by the server. */
  onBehalfOfUserId: string | null;
  /** The task's current assignee agent. */
  issueAssigneeAgentId?: string | null;
  /** Resolve a user id to a display name, when the directory is loaded. */
  resolveUserLabel?: (userId: string) => string | null | undefined;
}): { userName: string } | null {
  const { authorAgentId, onBehalfOfUserId, issueAssigneeAgentId, resolveUserLabel } = input;
  if (!authorAgentId || !onBehalfOfUserId) return null;
  // The assignee acting on its own task is the ordinary case, not a cross-issue write.
  if (issueAssigneeAgentId && authorAgentId === issueAssigneeAgentId) return null;
  // Falls back to "the responsible user" so the chip never shows a raw id.
  return { userName: responsibleUserLabel(resolveUserLabel?.(onBehalfOfUserId)) };
}
