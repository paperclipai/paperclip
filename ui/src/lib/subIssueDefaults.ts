import type { Issue } from "@paperclipai/shared";

type SubIssueDefaultSource = Pick<
  Issue,
  | "id"
  | "identifier"
  | "title"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "executionWorkspacePreference"
  | "assigneeAgentId"
  | "assigneeUserId"
>;

export function buildSubIssueDefaults(issue: SubIssueDefaultSource) {
  return buildSubIssueDefaultsForViewer(issue);
}

export function buildSubIssueDefaultsForViewer(
  issue: SubIssueDefaultSource,
  currentUserId?: string | null,
) {
  const shouldInheritUserAssignee = Boolean(issue.assigneeUserId && issue.assigneeUserId !== currentUserId);
  const inheritedAssigneeUserId = shouldInheritUserAssignee ? issue.assigneeUserId ?? undefined : undefined;

  return {
    parentId: issue.id,
    parentIdentifier: issue.identifier ?? undefined,
    parentTitle: issue.title,
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
    ...(issue.projectWorkspaceId ? { projectWorkspaceId: issue.projectWorkspaceId } : {}),
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    // A sub-task always gets its own workspace from the project base. It keeps
    // the parent's workspace mode, never the parent's workspace or files.
    ...(issue.executionWorkspacePreference && issue.executionWorkspacePreference !== "reuse_existing"
      ? { executionWorkspaceMode: issue.executionWorkspacePreference }
      : {}),
    ...(issue.assigneeAgentId ? { assigneeAgentId: issue.assigneeAgentId } : {}),
    ...(inheritedAssigneeUserId ? { assigneeUserId: inheritedAssigneeUserId } : {}),
  };
}
