import { formatAssigneeUserLabel } from "./assignees";

export interface CommentAuthorIdentityInput {
  authorAgentId?: string | null;
  authorUserId?: string | null;
  runAgentId?: string | null;
}

export interface CommentAuthorIdentity {
  kind: "agent" | "user";
  agentId: string | null;
  name: string;
}

export function resolveCommentAuthorIdentity(
  comment: CommentAuthorIdentityInput,
  currentUserId: string | null | undefined,
): CommentAuthorIdentity {
  if (comment.authorAgentId) {
    return {
      kind: "agent",
      agentId: comment.authorAgentId,
      name: comment.authorAgentId,
    };
  }

  if (comment.runAgentId) {
    return {
      kind: "agent",
      agentId: comment.runAgentId,
      name: comment.runAgentId,
    };
  }

  if (comment.authorUserId && currentUserId && comment.authorUserId === currentUserId) {
    return {
      kind: "user",
      agentId: null,
      name: "You",
    };
  }

  return {
    kind: "user",
    agentId: null,
    name: formatAssigneeUserLabel(comment.authorUserId, currentUserId) ?? "Board",
  };
}
