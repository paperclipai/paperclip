import { t } from "@/i18n";
import type { ActivityEvent } from "@paperclipai/shared";
import { assigneeValueFromSelection } from "./assignee-selection.js";
export { assigneeValueFromSelection, parseAssigneeValue, type AssigneeSelection } from "./assignee-selection.js";

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
        if (event.action === "issue.created" || event.action === "issue.child_created") return true;
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

export function currentUserAssigneeOption(currentUserId: string | null | undefined): AssigneeOption[] {
  if (!currentUserId) return [];
  return [{
    id: assigneeValueFromSelection({ assigneeUserId: currentUserId }),
    get "label"() { return t("display:copy_1182eb2ed06e"); },
    searchText: currentUserId === "local-board" ? "me board human local-board" : `me human ${currentUserId}`,
  }];
}

export function formatAssigneeUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
  userLabels?: ReadonlyMap<string, string> | Record<string, string> | null,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return t("display:copy_dd7a1b9e6312");
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
  if (userId === "local-board") return t("display:copy_4adc7e2210ad");
  return userId.slice(0, 5);
}
