export type WorktreeFileWorktreeKind = "execution_workspace" | "project_workspace";
export type WorktreeFileSelector = "auto" | "execution" | "project";
export type WorktreeFileListMode = "all" | "recent" | "changed";
export type WorktreeFilePreviewKind = "text" | "image" | "video" | "pdf" | "unsupported";
export type WorktreeFileResourceKind = "file" | "directory" | "remote_resource";
export type WorktreeFileContentEncoding = "utf8" | "base64";

export interface WorktreeFileRef {
  kind: "workspace_file";
  issueId?: string;
  projectId?: string;
  projectName?: string;
  workspaceKind: WorktreeFileWorktreeKind;
  workspaceId: string;
  relativePath: string;
  line?: number | null;
  column?: number | null;
  displayPath: string;
}

export interface ResolvedWorktreeResource {
  kind: WorktreeFileResourceKind;
  provider: "local_fs" | "git_worktree" | "remote_managed" | string;
  title: string;
  displayPath: string;
  workspaceLabel: string;
  workspaceKind: WorktreeFileWorktreeKind;
  workspaceId: string;
  projectId?: string | null;
  projectName?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  previewKind: WorktreeFilePreviewKind;
  denialReason?: string | null;
  capabilities: {
    preview: boolean;
    download: boolean;
    listChildren: boolean;
  };
}

export interface WorktreeFileContent {
  resource: ResolvedWorktreeResource;
  content: {
    encoding: WorktreeFileContentEncoding;
    data: string;
  };
}

export interface WorktreeFileListFileItem {
  kind: "file";
  provider: "local_fs" | "git_worktree" | string;
  title: string;
  relativePath: string;
  displayPath: string;
  workspaceLabel: string;
  workspaceKind: WorktreeFileWorktreeKind;
  workspaceId: string;
  projectId?: string | null;
  projectName?: string | null;
  contentType?: string | null;
  byteSize?: number | null;
  modifiedAt?: string | null;
  previewKind: WorktreeFilePreviewKind;
  capabilities: {
    preview: boolean;
    download: true;
    listChildren: false;
  };
}

export interface WorktreeFileListDirectoryItem {
  kind: "directory";
  provider: "local_fs" | "git_worktree" | string;
  title: string;
  relativePath: string;
  displayPath: string;
  workspaceLabel: string;
  workspaceKind: WorktreeFileWorktreeKind;
  workspaceId: string;
  projectId?: string | null;
  projectName?: string | null;
  contentType: null;
  byteSize: null;
  modifiedAt?: string | null;
  previewKind: "unsupported";
  capabilities: {
    preview: false;
    download: false;
    listChildren: true;
  };
}

export type WorktreeFileListItem = WorktreeFileListFileItem | WorktreeFileListDirectoryItem;

export interface WorktreeFileListResponse {
  kind: "workspace_file_list";
  state: "available" | "unavailable";
  unavailableReason?: string | null;
  workspace: {
    provider: "local_fs" | "git_worktree" | string;
    workspaceLabel: string;
    workspaceKind: WorktreeFileWorktreeKind;
    workspaceId: string;
    projectId?: string | null;
    projectName?: string | null;
  } | null;
  query: {
    workspace: WorktreeFileSelector;
    mode: WorktreeFileListMode;
    path?: string | null;
    q: string | null;
    limit: number;
    offset: number;
  };
  items: WorktreeFileListItem[];
  scannedCount: number;
  truncated: boolean;
}

export interface WorktreeFileAvailabilityQuery {
  path: string;
  workspace?: WorktreeFileSelector;
  projectId?: string;
  workspaceId?: string;
}

export interface NormalizedWorktreeFileAvailabilityQuery {
  path: string;
  workspace: WorktreeFileSelector;
  projectId: string | null;
  workspaceId: string | null;
}

export interface WorktreeFileAvailabilityRequest {
  queries: WorktreeFileAvailabilityQuery[];
}

export interface WorktreeFileAvailabilityResult {
  query: NormalizedWorktreeFileAvailabilityQuery;
  openable: boolean;
  unavailableReason?: string | null;
  resource: ResolvedWorktreeResource | null;
}

export interface WorktreeFileAvailabilityResponse {
  kind: "workspace_file_availability";
  results: WorktreeFileAvailabilityResult[];
}
