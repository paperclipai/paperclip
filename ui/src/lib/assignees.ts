export interface AssigneeSelection {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AssigneeOption {
  id: string;
  label: string;
  searchText?: string;
}

export function assigneeValueFromSelection(selection: Partial<AssigneeSelection>): string {
  if (selection.assigneeAgentId) return `agent:${selection.assigneeAgentId}`;
  if (selection.assigneeUserId) return `user:${selection.assigneeUserId}`;
  return "";
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

  // Older drafts/defaults stored a raw agent id. Keep parsing them so users
  // do not lose local draft state after the assignee UX upgrade.
  return { assigneeAgentId: value, assigneeUserId: null };
}

export function currentUserAssigneeOption(currentUserId: string | null | undefined): AssigneeOption[] {
  if (!currentUserId) return [];
  return [
    {
      id: assigneeValueFromSelection({ assigneeUserId: currentUserId }),
      label: "Me",
      searchText: currentUserId === "local-board" ? "me board human local-board" : `me human ${currentUserId}`,
    },
  ];
}

export function formatAssigneeUserLabel(
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
): string | null {
  if (!userId) return null;
  if (currentUserId && userId === currentUserId) return "Me";
  if (userId === "local-board") return "Board";
  return userId.slice(0, 5);
}
