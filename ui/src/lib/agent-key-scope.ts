import { isUuidLike, type AgentApiKeyScope } from "@paperclipai/shared";

export type AgentKeyScopeMode = "standard" | "task_bridge";

export interface AgentKeyScopeDraft {
  mode: AgentKeyScopeMode;
  projectId: string;
  parentIssueId: string;
  allowedAssigneeAgentIds: string[];
}

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function validateAgentKeyScopeDraft(draft: AgentKeyScopeDraft): string | null {
  if (draft.mode === "standard") return null;
  const projectId = draft.projectId.trim();
  const parentIssueId = draft.parentIssueId.trim();
  if (!projectId && !parentIssueId) {
    return "Choose a project boundary or enter a parent issue id.";
  }
  if (projectId && !isUuidLike(projectId)) {
    return "Project boundary must be a valid UUID.";
  }
  if (parentIssueId && !isUuidLike(parentIssueId)) {
    return "Parent issue id must be a valid UUID.";
  }
  const allowedAssigneeAgentIds = uniqueIds(draft.allowedAssigneeAgentIds);
  if (allowedAssigneeAgentIds.length > 50) {
    return "Task bridge keys support at most 50 allowed assignees.";
  }
  if (allowedAssigneeAgentIds.some((agentId) => !isUuidLike(agentId))) {
    return "Every allowed assignee must have a valid UUID.";
  }
  return null;
}

export function buildAgentKeyScopePayload(draft: AgentKeyScopeDraft): AgentApiKeyScope {
  if (draft.mode === "standard") return { kind: "standard" };
  const projectId = draft.projectId.trim();
  const parentIssueId = draft.parentIssueId.trim();
  const allowedAssigneeAgentIds = uniqueIds(draft.allowedAssigneeAgentIds);
  return {
    kind: "task_bridge",
    ...(projectId ? { projectId } : {}),
    ...(parentIssueId ? { parentIssueId } : {}),
    ...(allowedAssigneeAgentIds.length > 0 ? { allowedAssigneeAgentIds } : {}),
  };
}

export function describeAgentKeyScope(scope: AgentApiKeyScope | null | undefined): string {
  if (!scope || scope.kind === "standard") return "Standard";
  if (scope.kind === "skill_test") return "Skill test";
  const boundaryCount =
    (scope.projectId ? 1 : 0) +
    (scope.projectIds?.length ?? 0) +
    (scope.parentIssueId ? 1 : 0) +
    (scope.parentIssueIds?.length ?? 0);
  const assigneeCount = scope.allowedAssigneeAgentIds?.length ?? 0;
  const boundaryLabel = boundaryCount === 1 ? "1 boundary" : `${boundaryCount} boundaries`;
  const assigneeLabel =
    assigneeCount > 0
      ? `, ${assigneeCount} allowed assignee${assigneeCount === 1 ? "" : "s"}`
      : "";
  return `Task bridge (${boundaryLabel}${assigneeLabel})`;
}
