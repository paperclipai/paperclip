/** Stable cleanup outcome for a shared or project-primary record-only archive. */
export const SHARED_WORKSPACE_RECORD_ONLY_ARCHIVE_REASON =
  "shared_workspace_record_only_archive" as const;

export function isRecordOnlyArchiveWorkspace(input: {
  mode: string;
  isProjectPrimaryWorkspace: boolean;
}): boolean {
  return input.mode === "shared_workspace" || input.isProjectPrimaryWorkspace;
}

export function resolveIsProjectPrimaryWorkspace(input: {
  projectWorkspaceId: string | null;
  primaryProjectWorkspaceId: string | null;
  workspacePath: string | null;
  projectWorkspacePath: string | null;
}): boolean {
  if (
    input.projectWorkspaceId == null
    || input.primaryProjectWorkspaceId == null
    || input.workspacePath == null
    || input.projectWorkspacePath == null
  ) {
    return false;
  }
  return (
    input.projectWorkspaceId === input.primaryProjectWorkspaceId
    && input.workspacePath === input.projectWorkspacePath
  );
}
