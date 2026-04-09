export type ExecutionWorkspaceStrategyType =
  | "project_primary"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type ProjectExecutionWorkspaceDefaultMode =
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "adapter_default";

export type ExecutionWorkspaceMode =
  | "inherit"
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "reuse_existing"
  | "agent_default";

export type ExecutionWorkspaceProviderType =
  | "local_fs"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type ExecutionWorkspaceStatus =
  | "active"
  | "idle"
  | "in_review"
  | "archived"
  | "cleanup_failed";

export type ExecutionWorkspaceCloseReadinessState =
  | "ready"
  | "ready_with_warnings"
  | "blocked";

export type ExecutionWorkspaceCloseActionKind =
  | "archive_record"
  | "stop_runtime_services"
  | "cleanup_command"
  | "teardown_command"
  | "git_worktree_remove"
  | "git_branch_delete"
  | "remove_local_directory";

export type WorkspaceRuntimeDesiredState = "running" | "stopped";

export interface ExecutionWorkspaceStrategy {
  type: ExecutionWorkspaceStrategyType;
  baseRef?: string | null;
  branchTemplate?: string | null;
  worktreeParentDir?: string | null;
  provisionCommand?: string | null;
  teardownCommand?: string | null;
}

export interface ExecutionWorkspaceConfig {
  provisionCommand: string | null;
  teardownCommand: string | null;
  cleanupCommand: string | null;
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
}

export interface ProjectWorkspaceRuntimeConfig {
  workspaceRuntime: Record<string, unknown> | null;
  desiredState: WorkspaceRuntimeDesiredState | null;
}

export interface ExecutionWorkspaceCloseAction {
  kind: ExecutionWorkspaceCloseActionKind;
  label: string;
  description: string;
  command: string | null;
}

export interface ExecutionWorkspaceCloseLinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  isTerminal: boolean;
}

export interface ExecutionWorkspaceCloseGitReadiness {
  repoRoot: string | null;
  workspacePath: string | null;
  branchName: string | null;
  baseRef: string | null;
  hasDirtyTrackedFiles: boolean;
  hasUntrackedFiles: boolean;
  dirtyEntryCount: number;
  untrackedEntryCount: number;
  aheadCount: number | null;
  behindCount: number | null;
  isMergedIntoBase: boolean | null;
  createdByRuntime: boolean;
}

export interface ExecutionWorkspaceCloseReadiness {
  workspaceId: string;
  state: ExecutionWorkspaceCloseReadinessState;
  blockingReasons: string[];
  warnings: string[];
  linkedIssues: ExecutionWorkspaceCloseLinkedIssue[];
  plannedActions: ExecutionWorkspaceCloseAction[];
  isDestructiveCloseAllowed: boolean;
  isSharedWorkspace: boolean;
  isProjectPrimaryWorkspace: boolean;
  git: ExecutionWorkspaceCloseGitReadiness | null;
  runtimeServices: WorkspaceRuntimeService[];
}

export interface ProjectExecutionWorkspacePolicy {
  enabled: boolean;
  defaultMode?: ProjectExecutionWorkspaceDefaultMode;
  allowIssueOverride?: boolean;
  defaultProjectWorkspaceId?: string | null;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
  branchPolicy?: Record<string, unknown> | null;
  pullRequestPolicy?: Record<string, unknown> | null;
  runtimePolicy?: Record<string, unknown> | null;
  cleanupPolicy?: Record<string, unknown> | null;
}

export interface IssueExecutionWorkspaceSettings {
  mode?: ExecutionWorkspaceMode;
  workspaceStrategy?: ExecutionWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
}

export interface ExecutionWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing" | "agent_default"> | "adapter_managed" | "cloud_sandbox";
  strategyType: ExecutionWorkspaceStrategyType;
  name: string;
  status: ExecutionWorkspaceStatus;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: ExecutionWorkspaceProviderType;
  providerRef: string | null;
  derivedFromExecutionWorkspaceId: string | null;
  lastUsedAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  cleanupEligibleAt: Date | null;
  cleanupReason: string | null;
  config: ExecutionWorkspaceConfig | null;
  metadata: Record<string, unknown> | null;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceRuntimeService {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
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
