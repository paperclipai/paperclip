import type { ExecutionWorkspaceMode, ProjectExecutionWorkspaceDefaultMode } from "@paperclipai/shared";

type ProjectWorkspaceDefaultSource = {
  workspaces?: Array<{ id: string; isPrimary: boolean }>;
  executionWorkspacePolicy?: {
    enabled?: boolean;
    defaultMode?: ProjectExecutionWorkspaceDefaultMode | string | null;
    defaultProjectWorkspaceId?: string | null;
  } | null;
} | null | undefined;

export function defaultProjectWorkspaceIdForProject(project: ProjectWorkspaceDefaultSource) {
  if (!project) return "";
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? "";
}

export function defaultExecutionWorkspaceModeForProject(project: ProjectWorkspaceDefaultSource): ExecutionWorkspaceMode {
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

export function issueExecutionWorkspaceModeForExistingWorkspace(
  mode: string | null | undefined,
): ExecutionWorkspaceMode {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}
