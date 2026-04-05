import type { IssueComment } from "@paperclipai/shared";
import { formatAssigneeUserLabel } from "./assignees";

export type CommentAuthorIdentity =
  | { kind: "agent"; agentId: string }
  | { kind: "user"; label: string };

type CommentAuthorInput = Pick<IssueComment, "authorAgentId" | "authorUserId"> & {
  runAgentId?: string | null;
};

export function resolveCommentAuthorIdentity(
  comment: CommentAuthorInput,
  currentUserId: string | null | undefined,
): CommentAuthorIdentity {
  if (comment.authorAgentId) {
    return { kind: "agent", agentId: comment.authorAgentId };
  }

  if (comment.authorUserId) {
    if (currentUserId && comment.authorUserId === currentUserId) {
      return { kind: "user", label: "You" };
    }
    const label = formatAssigneeUserLabel(comment.authorUserId, currentUserId) ?? "Board";
    return { kind: "user", label };
  }
  if (comment.runAgentId) {
    return { kind: "agent", agentId: comment.runAgentId };
  }

  return { kind: "user", label: "Board" };
}
