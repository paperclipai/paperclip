import { assigneeValueFromSelection } from "./assignees";

export interface IssueDraftDefaults {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
}

export interface PersistedIssueDraft {
  assigneeValue?: string;
  assigneeId?: string;
  projectId?: string;
}

export function resolveDraftAssigneeValue(
  defaults: IssueDraftDefaults,
  draft: PersistedIssueDraft | null,
): string {
  if (defaults.assigneeAgentId || defaults.assigneeUserId) {
    return assigneeValueFromSelection(defaults);
  }
  return draft?.assigneeValue ?? draft?.assigneeId ?? "";
}

export function nextTitleTabTarget(input: {
  assigneeValue: string;
  projectId: string;
}): "assignee" | "project" | "description" {
  if (!input.assigneeValue) return "assignee";
  if (!input.projectId) return "project";
  return "description";
}

export function nextAssigneeConfirmTarget(projectId: string): "project" | "description" {
  return projectId ? "description" : "project";
}
