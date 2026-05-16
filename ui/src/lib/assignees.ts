export interface AssigneeSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneeOption {
  id: string;
  label: string;
  searchText?: string;
}

interface CommentAssigneeSuggestionParticipant {
  type?: string | null;
  userId?: string | null;
  agentId?: string | null;
}

interface CommentAssigneeSuggestionExecutionState {
  currentParticipant?: CommentAssigneeSuggestionParticipant | null;
}

interface CommentAssigneeSuggestionInput {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  status?: string | null;
  executionState?: CommentAssigneeSuggestionExecutionState | null;
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

function isCurrentStageParticipant(
  participant: CommentAssigneeSuggestionParticipant | null | undefined,
  currentUserId: string | null | undefined,
  currentAgentId: string | null | undefined,
): boolean {
  if (!participant) return false;
  if (participant.userId) {
    return Boolean(currentUserId && participant.userId === currentUserId);
  }
  if (participant.agentId) {
    return Boolean(currentAgentId && participant.agentId === currentAgentId);
  }
  return false;
}

export function suggestedCommentAssigneeValue(
  issue: CommentAssigneeSuggestionInput,
  comments: CommentAssigneeSuggestionComment[] | null | undefined,
  currentUserId: string | null | undefined,
  currentAgentId?: string | null | undefined,
): string {
  // When the ticket is actively in review/approval AND the caller holds the
  // current stage, skip the "last non-me commenter" hint. Auto-suggesting a
  // different assignee here would make the composer silently send a reassign
  // PATCH, which the execution-policy engine rejects with
  // "Only the active reviewer or approver can advance the current execution
  // stage" (see server/src/services/issue-execution-policy.ts).
  // Non-participants opening the same ticket still get the normal suggestion.
  if (
    issue.status === "in_review" &&
    isCurrentStageParticipant(issue.executionState?.currentParticipant, currentUserId, currentAgentId)
  ) {
    return assigneeValueFromSelection(issue);
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

  return assigneeValueFromSelection(issue);
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
  if (userLabels) {
    const label = userLabels instanceof Map
      ? userLabels.get(userId)
      : (userLabels as Record<string, string>)[userId];
    if (typeof label === "string" && label.trim()) return label;
  }
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}
