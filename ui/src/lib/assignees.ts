import type { ActivityEvent } from "@paperclipai/shared";

export interface AssigneeSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneeOption {
  id: string;
  label: string;
  searchText?: string;
}

interface CommentAssigneeSuggestionInput {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}

interface CommentAssigneeSuggestionComment {
  authorAgentId?: string | null;
  authorUserId?: string | null;
}

export function assigneeValueFromSelection(selection: Partial<AssigneeSelection>): string {
  if (selection.assigneeAgentId) return `agent:${selection.assigneeAgentId}`;
  if (selection.assigneeUserId) return `user:${selection.assigneeUserId}`;
  return "";
}

export function suggestedCommentAssigneeValue(
  issue: CommentAssigneeSuggestionInput,
  comments: CommentAssigneeSuggestionComment[] | null | undefined,
  currentUserId: string | null | undefined,
  currentAgentId?: string | null | undefined,
  activity: readonly ActivityEvent[] = [],
): string {
  const assignedToCurrentUser = Boolean(currentUserId && issue.assigneeUserId === currentUserId);
  if (assignedToCurrentUser) {
    const assignment = activity
      .filter((event) => {
        if (event.actorType !== "agent" || !event.actorId || event.actorId === currentAgentId) return false;
        const details = event.details;
        if (!details || details.assigneeUserId !== currentUserId) return false;
        if (event.action === "issue.created") return true;
        if (event.action === "issue.reassigned") {
          return details.changed === true
            && Object.hasOwn(details, "previousAssigneeUserId")
            && details.previousAssigneeUserId !== currentUserId;
        }
        if (event.action !== "issue.updated") return false;
        const previous = details._previous;
        // Updates can resend unchanged fields. Only a real assignment counts.
        return previous !== null && typeof previous === "object"
          && Object.hasOwn(previous, "assigneeUserId")
          && (previous as Record<string, unknown>).assigneeUserId !== currentUserId;
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (assignment) return `agent:${assignment.actorId}`;
  }

  if (comments && comments.length > 0 && (currentUserId || currentAgentId)) {
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i];
      if (comment.authorAgentId && comment.authorAgentId !== currentAgentId) {
        return assigneeValueFromSelection({ assigneeAgentId: comment.authorAgentId });
      }
      if (comment.authorUserId && comment.authorUserId !== currentUserId) {
        return assigneeValueFromSelection({ assigneeUserId: comment.authorUserId });
      }
    }
  }

  return assignedToCurrentUser ? "" : assigneeValueFromSelection(issue);
}

export function parseAssigneeValue(value: string): AssigneeSelection {
  if (!value) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (value.startsWith("agent:")) {
    const assigneeAgentId = value.slice("agent:".length);
    return { assigneeAgentId: assigneeAgentId || null, assigneeUserId: null };
  }
  if (value.startsWith("user:")) {
    const assigneeUserId = value.slice("user:".length);
    return { assigneeAgentId: null, assigneeUserId: assigneeUserId || null };
  }
  // Backward compatibility for older drafts/defaults that stored a raw agent id.
  return { assigneeAgentId: value, assigneeUserId: null };
}

export function currentUserAssigneeOption(currentUserId: string | null | undefined): AssigneeOption[] {
  if (!currentUserId) return [];
  return [{
    id: assigneeValueFromSelection({ assigneeUserId: currentUserId }),
    label: "Me",
    searchText: currentUserId === "local-board" ? "me board human local-board" : `me human ${currentUserId}`,
  }];
}

export function formatAssigneeUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return "You";
  return formatUserLabel(userId, userLabels);
}

export function formatUserLabel(
  userId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (userLabels) {
    const label = userLabels instanceof Map
      ? userLabels.get(userId)
      : (userLabels as Record<string, string>)[userId];
    if (typeof label === "string" && label.trim()) return label;
  }
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}
