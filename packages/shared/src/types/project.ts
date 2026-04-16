import type { ClientMetadata } from "./client.js";
import type { ClientStatus, PauseReason, ProjectStatus } from "../constants.js";
import type { AgentEnvConfig } from "./secrets.js";
import type {
  ProjectExecutionWorkspacePolicy,
  ProjectWorkspaceRuntimeConfig,
  WorkspaceRuntimeService,
} from "./workspace-runtime.js";

export type ProjectWorkspaceSourceType = "local_path" | "git_repo" | "remote_managed" | "non_git_path";
export type ProjectWorkspaceVisibility = "default" | "advanced";

export interface ProjectGoalRef {
  id: string;
  title: string;
}

export interface ProjectWorkspace {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string | null;
  cleanupCommand: string | null;
  remoteProvider: string | null;
  remoteWorkspaceRef: string | null;
  sharedWorkspaceKey: string | null;
  metadata: Record<string, unknown> | null;
  runtimeConfig: ProjectWorkspaceRuntimeConfig | null;
  isPrimary: boolean;
  runtimeServices?: WorkspaceRuntimeService[];
  createdAt: Date;
  updatedAt: Date;
}

export type ProjectCodebaseOrigin = "local_folder" | "managed_checkout";

export interface ProjectCodebase {
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  defaultRef: string | null;
  repoName: string | null;
  localFolder: string | null;
  managedFolder: string;
  effectiveLocalFolder: string;
  origin: ProjectCodebaseOrigin;
}

export interface ProjectClientRef {
  linkId: string;
  clientId: string;
  name: string;
  email: string | null;
  phone: string | null;
  contactName: string | null;
  notes: string | null;
  status: ClientStatus;
  metadata: ClientMetadata | null;
  relationshipDescription: string | null;
  relationshipTags: string[];
  linkedAt: Date;
}

export type ProjectFilePreviewType = "text" | "markdown" | "json" | "image" | "binary";

export type ProjectFileType = "text" | "directory" | "image" | "binary";

export interface ProjectFilesAheadBehind {
  ahead: number | null;
  behind: number | null;
}

export interface ProjectFilesDirtyState {
  hasDirtyTrackedFiles: boolean;
  hasUntrackedFiles: boolean;
  dirtyEntryCount: number;
  untrackedEntryCount: number;
}

export interface ProjectFilesBranch {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  tracking: string | null;
}

export interface ProjectFilesTreeEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  hiddenByDefault: boolean;
  fileType: ProjectFileType;
}

export interface ProjectFilesTreeResponse {
  path: string;
  entries: ProjectFilesTreeEntry[];
}

export interface ProjectFileDetail {
  path: string;
  name: string;
  fileType: ProjectFileType;
  previewType: ProjectFilePreviewType;
  size: number;
  language: string | null;
  textContent: string | null;
  base64Content: string | null;
  mimeType: string | null;
  updatedAt: Date;
}

export interface ProjectFilesSummary {
  available: boolean;
  companyId: string;
  projectId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  rootPath: string | null;
  repoRoot: string | null;
  gitEnabled: boolean;
  hasRemote: boolean;
  currentBranch: string | null;
  branches: ProjectFilesBranch[];
  dirtyWorktree: ProjectFilesDirtyState | null;
  aheadBehind: ProjectFilesAheadBehind | null;
}

export interface ProjectFilesSyncResult {
  status: "success" | "conflict" | "auth_error" | "error";
  summary: ProjectFilesSummary;
  message: string | null;
}

export type ProjectFilesBranchSyncAction =
  | "pushed_to_remote"
  | "created_local_tracking"
  | "remote_deleted_local_remains"
  | "already_in_sync"
  | "error";

export interface ProjectFilesBranchSyncDetail {
  branchName: string;
  action: ProjectFilesBranchSyncAction;
  errorMessage: string | null;
}

export interface ProjectFilesBranchSyncResult {
  status: "success" | "partial" | "auth_error" | "error";
  details: ProjectFilesBranchSyncDetail[];
  summary: ProjectFilesSummary;
  message: string | null;
}

export interface GitStatusEntry {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workingStatus: string;
  isStaged: boolean;
  isUnstaged: boolean;
  isUntracked: boolean;
}

export interface GitStatusResponse {
  entries: GitStatusEntry[];
}

export interface GitDiffResponse {
  diff: string;
  path: string;
}

export interface GitCommitResult {
  status: "success" | "error" | "nothing_to_commit";
  message: string | null;
  sha: string | null;
}

export interface GitPushResult {
  status: "success" | "error" | "auth_error";
  message: string | null;
}

export interface Project {
  id: string;
  companyId: string;
  urlKey: string;
  /** @deprecated Use goalIds / goals instead */
  goalId: string | null;
  goalIds: string[];
  goals: ProjectGoalRef[];
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  env: AgentEnvConfig | null;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  executionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  codebase: ProjectCodebase;
  clients: ProjectClientRef[];
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
