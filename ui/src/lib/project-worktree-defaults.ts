import type { ExecutionWorktreeMode, ProjectExecutionWorktreeDefaultMode } from "@paperclipai/shared";

type ProjectWorktreeDefaultSource = {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: {
    enabled?: boolean;
    defaultMode?: ProjectExecutionWorktreeDefaultMode | string | null;
    defaultProjectWorkspaceId?: string | null;
  } | null;
} | null | undefined;

export function defaultProjectWorktreeIdForProject(project: ProjectWorktreeDefaultSource) {
  if (!project) return "";
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((worktree) => worktree.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? "";
}

export function defaultExecutionWorktreeModeForProject(project: ProjectWorktreeDefaultSource): ExecutionWorktreeMode {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (
    defaultMode === "isolated_workspace" ||
    defaultMode === "operator_branch" ||
    defaultMode === "adapter_default"
  ) {
    return defaultMode === "adapter_default" ? "agent_default" : defaultMode;
  }
  return "shared_workspace";
}

export function issueExecutionWorktreeModeForExistingWorktree(
  mode: string | null | undefined,
): ExecutionWorktreeMode {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}
