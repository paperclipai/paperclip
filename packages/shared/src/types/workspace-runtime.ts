export type ExecutionWorkspaceStrategyType = "project_primary" | "git_worktree";

export type ExecutionWorkspaceMode = "inherit" | "project_primary" | "isolated" | "agent_default";

export interface ExecutionWorkspaceStrategy {
  type: ExecutionWorkspaceStrategyType;
  baseRef?: string | null;
  branchTemplate?: string | null;
  worktreeParentDir?: string | null;
  provisionCommand?: string | null;
  teardownCommand?: string | null;
}

export interface ProjectExecutionWorkspacePolicy {
  enabled: boolean;
  defaultMode?: "project_primary" | "isolated";
  allowIssueOverride?: boolean;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
  branchPolicy?: Record<string, unknown> | null;
  pullRequestPolicy?: Record<string, unknown> | null;
  cleanupPolicy?: Record<string, unknown> | null;
}

export interface IssueExecutionWorkspaceSettings {
  mode?: ExecutionWorkspaceMode;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
}

export interface WorkspaceRuntimeService {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  issueId: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  createdAt: Date;
  updatedAt: Date;
}
