/** Durable Paperclip files; CLI homes and caches are deliberately not scopes. */
export const WORK_FOLDER_SCOPES = ["task", "agent", "user", "project"] as const;
export type WorkFolderScope = (typeof WORK_FOLDER_SCOPES)[number];
export const WORK_FOLDER_SYNC_INTERVAL_MS = 180_000;
export const WORK_FOLDER_ROUTE_PATH = "/companies/:companyId/work-folders/:scope/:ownerId";

export interface WorkFolderOwner {
  companyId: string;
  scope: WorkFolderScope;
  ownerId: string;
}

export interface WorkFile {
  id: string;
  path: string;
  kind: "file" | "directory";
  byteSize: number;
  sha256: string | null;
  executable: boolean;
  contentType: string;
  deletedAt: string | null;
  updatedAt: string;
}

export interface WorkFolderListing {
  id: string;
  owner: WorkFolderOwner;
  files: WorkFile[];
  nextCursor: string | null;
  /** Last accepted file operation, including deletion, restore, and retries. */
  lastOperationAt: string | null;
}

export interface WorkFolderSyncStatus {
  runId: string;
  state: "starting" | "saved" | "saving" | "failed";
  lastSavedAt: string | null;
  error: string | null;
  refreshRequested: boolean;
  active: boolean;
}

export interface SandboxWorkFolderManifest {
  version: 1;
  companyId: string;
  runId: string;
  taskId: string | null;
  agentId: string;
  responsibleUserId: string | null;
  projectId: string | null;
  leaseId: string;
  sandboxKey: string;
  home: string;
  finalCheckpointAt?: string;
  folders: Record<WorkFolderScope, string | null>;
  repositories: Array<{ bindingId: string; workspaceId: string; name: string; primary: boolean }>;
}

/** Reject ambiguous paths instead of normalizing traversal into a valid path. */
export function validateWorkFilePath(value: string): string {
  if (!value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || part === ".paperclip-runtime")) {
    throw new Error("Invalid work file path");
  }
  return value;
}
