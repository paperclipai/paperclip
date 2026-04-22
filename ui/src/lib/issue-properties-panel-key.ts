import type { Issue } from "@paperclipai/shared";

type IssuePropertiesPanelKeyIssue = Pick<
  Issue,
  | "id"
  | "status"
  | "priority"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "projectId"
  | "projectWorkspaceId"
  | "parentId"
  | "createdByUserId"
  | "hiddenAt"
  | "labelIds"
  | "executionPolicy"
  | "executionState"
  | "executionWorkspaceId"
  | "executionWorkspacePreference"
  | "executionWorkspaceSettings"
  | "currentExecutionWorkspace"
  | "blocks"
  | "blockedBy"
  | "ancestors"
>;

type IssuePropertiesPanelKeyChild = Pick<Issue, "id" | "updatedAt" | "identifier" | "title">;

export function buildIssuePropertiesPanelKey(
  issue: IssuePropertiesPanelKeyIssue | null | undefined,
  childIssues: readonly IssuePropertiesPanelKeyChild[],
) {
  if (!issue) return "";

  return JSON.stringify({
    id: issue.id,
    status: issue.status,
    priority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    parentId: issue.parentId,
    createdByUserId: issue.createdByUserId,
    hiddenAt: issue.hiddenAt,
    labelIds: issue.labelIds ?? [],
    executionWorkspaceId: issue.executionWorkspaceId,
    executionWorkspacePreference: issue.executionWorkspacePreference,
    executionWorkspaceSettings: issue.executionWorkspaceSettings ?? null,
    currentExecutionWorkspace: issue.currentExecutionWorkspace
      ? {
          id: issue.currentExecutionWorkspace.id,
          mode: issue.currentExecutionWorkspace.mode,
          status: issue.currentExecutionWorkspace.status,
          projectWorkspaceId: issue.currentExecutionWorkspace.projectWorkspaceId,
          branchName: issue.currentExecutionWorkspace.branchName,
          cwd: issue.currentExecutionWorkspace.cwd,
          runtimeServices: (issue.currentExecutionWorkspace.runtimeServices ?? []).map((service) => ({
            id: service.id,
            status: service.status,
            url: service.url,
          })),
        }
      : null,
    executionPolicy: issue.executionPolicy ?? null,
    executionState: issue.executionState
      ? {
          status: issue.executionState.status,
          currentStageType: issue.executionState.currentStageType,
          currentParticipant: issue.executionState.currentParticipant,
          returnAssignee: issue.executionState.returnAssignee,
        }
      : null,
    blocks: (issue.blocks ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      status: relation.status,
    })),
    blockedBy: (issue.blockedBy ?? []).map((relation) => ({
      id: relation.id,
      identifier: relation.identifier ?? null,
      title: relation.title,
      status: relation.status,
    })),
    parentSummary: issue.ancestors?.[0]
      ? {
          id: issue.ancestors[0].id,
          identifier: issue.ancestors[0].identifier ?? null,
          title: issue.ancestors[0].title,
        }
      : null,
    childIssues: childIssues.map((child) => ({
      id: child.id,
      updatedAt: String(child.updatedAt),
      identifier: child.identifier ?? null,
      title: child.title,
    })),
  });
}
