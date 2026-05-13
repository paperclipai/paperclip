export type ExecutionWorkspaceStrategyType =
  | "project_primary"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export interface ExecutionWorkspaceStrategy {
  type: ExecutionWorkspaceStrategyType;
  baseRef?: string | null;
  branchTemplate?: string | null;
  worktreeParentDir?: string | null;
  provisionCommand?: string | null;
  teardownCommand?: string | null;
}

export type WorkspaceRealizationTransport = "local" | "ssh" | "sandbox" | "plugin";

export type WorkspaceRealizationSyncStrategy =
  | "none"
  | "ssh_git_import_export"
  | "sandbox_archive_upload_download"
  | "provider_defined";

export interface WorkspaceRealizationRequest {
  version: 1;
  adapterType: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string;
  requestedMode: string | null;
  source: {
    kind: "project_primary" | "task_session" | "agent_home";
    localPath: string;
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    strategy: "project_primary" | "git_worktree";
    branchName: string | null;
    worktreePath: string | null;
  };
  runtimeOverlay: {
    provisionCommand: string | null;
    teardownCommand: string | null;
    cleanupCommand: string | null;
    workspaceRuntime: Record<string, unknown> | null;
  };
}

export interface WorkspaceRealizationRecord {
  version: 1;
  transport: WorkspaceRealizationTransport;
  provider: string | null;
  environmentId: string;
  leaseId: string;
  providerLeaseId: string | null;
  local: {
    path: string;
    source: WorkspaceRealizationRequest["source"]["kind"];
    strategy: WorkspaceRealizationRequest["source"]["strategy"];
    projectId: string | null;
    projectWorkspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
    worktreePath: string | null;
  };
  remote: {
    path: string | null;
    host?: string | null;
    port?: number | null;
    username?: string | null;
    sandboxId?: string | null;
  };
  sync: {
    strategy: WorkspaceRealizationSyncStrategy;
    prepare: string;
    syncBack: string | null;
  };
  bootstrap: {
    command: string | null;
  };
  rebuild: {
    executionWorkspaceId: string | null;
    mode: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    localPath: string;
    remotePath: string | null;
    providerLeaseId: string | null;
    metadata: Record<string, unknown>;
  };
  summary: string;
}
