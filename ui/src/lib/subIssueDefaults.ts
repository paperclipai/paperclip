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
  | "executionWorkspaceSettings"
  | "assigneeAgentId"
  | "assigneeUserId"
> & Partial<Pick<Issue, "currentExecutionWorkspace">>;

// Modes a sub-task can start with on its own. `reuse_existing` and
// `operator_branch` would point the sub-task at the parent's files or branch.
const INDEPENDENT_SUB_ISSUE_MODES = new Set(["shared_workspace", "isolated_workspace", "agent_default"]);

function independentSubIssueMode(issue: SubIssueDefaultSource): string | null {
  for (const candidate of [
    issue.executionWorkspacePreference,
    issue.executionWorkspaceSettings?.mode,
    issue.currentExecutionWorkspace?.mode,
  ]) {
    if (typeof candidate === "string" && INDEPENDENT_SUB_ISSUE_MODES.has(candidate)) return candidate;
  }
  return null;
}

export function buildSubIssueDefaults(issue: SubIssueDefaultSource) {
  return buildSubIssueDefaultsForViewer(issue);
}

export function buildSubIssueDefaultsForViewer(
  issue: SubIssueDefaultSource,
  currentUserId?: string | null,
) {
  const shouldInheritUserAssignee = Boolean(issue.assigneeUserId && issue.assigneeUserId !== currentUserId);
  const inheritedAssigneeUserId = shouldInheritUserAssignee ? issue.assigneeUserId ?? undefined : undefined;
  // A sub-task always gets its own workspace from the project base. It keeps
  // the parent's workspace mode, never the parent's workspace or files.
  const executionWorkspaceMode = independentSubIssueMode(issue);

  return {
    parentId: issue.id,
    parentIdentifier: issue.identifier ?? undefined,
    parentTitle: issue.title,
    ...(issue.projectId ? { projectId: issue.projectId } : {}),
    ...(issue.projectWorkspaceId ? { projectWorkspaceId: issue.projectWorkspaceId } : {}),
    ...(issue.goalId ? { goalId: issue.goalId } : {}),
    ...(executionWorkspaceMode ? { executionWorkspaceMode } : {}),
    ...(issue.assigneeAgentId ? { assigneeAgentId: issue.assigneeAgentId } : {}),
    ...(inheritedAssigneeUserId ? { assigneeUserId: inheritedAssigneeUserId } : {}),
  };
}
