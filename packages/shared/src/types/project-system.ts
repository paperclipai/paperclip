import type { IssueWorkProduct } from "./work-product.js";

export type WorkspaceBrowserKind = "project_codebase" | "project_workspace" | "execution_workspace";

export interface WorkspaceFileBrowserEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  byteSize: number | null;
  extension: string | null;
  updatedAt: Date | null;
  contentType: string | null;
  previewable: boolean;
}

export interface WorkspaceFileBrowserListing {
  workspaceKind: WorkspaceBrowserKind;
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  currentPath: string;
  parentPath: string | null;
  entries: WorkspaceFileBrowserEntry[];
}

export interface WorkspaceFileBrowserContent {
  workspaceKind: WorkspaceBrowserKind;
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
  path: string;
  byteSize: number;
  contentType: string | null;
  previewable: boolean;
  truncated: boolean;
  content: string;
}

export interface ProjectWorkProduct extends IssueWorkProduct {
  issueTitle: string;
  issueIdentifier: string | null;
  issueStatus: string;
}
