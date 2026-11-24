export const WORKSPACE_FILES_UNAVAILABLE_KEY = "workspaceFilesUnavailable";
export const WORKSPACE_FILES_UNAVAILABLE_SCHEMA = "paperclip.workspace-files-unavailable.v1";
export const WORKSPACE_FILES_UNAVAILABLE_MESSAGE =
  "This workspace's files were not available when it moved to new storage, so they cannot be restored. Continue the task in a new workspace.";

export type WorkspaceFilesUnavailable = {
  schema: typeof WORKSPACE_FILES_UNAVAILABLE_SCHEMA;
  reason: "files_missing_at_migration";
  recordedAt: string;
  localPath: string;
};

export function workspaceFilesUnavailableRecord(localPath: string, at: Date): WorkspaceFilesUnavailable {
  return { schema: WORKSPACE_FILES_UNAVAILABLE_SCHEMA, reason: "files_missing_at_migration", recordedAt: at.toISOString(), localPath };
}

export function readWorkspaceFilesUnavailable(metadata: Record<string, unknown> | null | undefined): WorkspaceFilesUnavailable | null {
  const value = metadata?.[WORKSPACE_FILES_UNAVAILABLE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record.schema === WORKSPACE_FILES_UNAVAILABLE_SCHEMA && record.reason === "files_missing_at_migration"
    && typeof record.recordedAt === "string" && typeof record.localPath === "string" ? record as WorkspaceFilesUnavailable : null;
}
