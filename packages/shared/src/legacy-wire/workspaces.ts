/** Legacy-wire boundary. Do not rename these persisted or network contract values in Phase 1. */
export const LEGACY_WORKSPACE_WIRE = {
  projectPathSegment: "workspaces",
  executionPathSegment: "execution-workspaces",
  projectPermission: "project.workspaces.read",
  executionPermission: "execution.workspaces.read",
  projectScope: "project_workspace",
  executionScope: "execution_workspace",
  fileResourceKind: "workspace_file",
  overviewScope: "workspaces_overview",
} as const;

export const LEGACY_WORKSPACE_ENV_KEYS = [
  "PAPERCLIP_WORKSPACE_CWD",
  "PAPERCLIP_WORKSPACE_ID",
  "PAPERCLIP_WORKSPACES_JSON",
  "PAPERCLIP_PROJECT_WORKSPACE_ID",
] as const;
