/** Filesystem intent is independent of a task's organizational project. */
export type TaskWorkspaceSelection =
  | { kind: "task_directory" }
  | { kind: "existing"; workspaceId: string }
  | { kind: "configured_source"; projectWorkspaceId: string; mode: "shared" | "managed_isolated" };
export type TaskWorkspaceIntent = {
  version: 1;
  request?: { key: string; expectedBindingRevision: number };
  selection: TaskWorkspaceSelection;
  source: "explicit" | "parent" | "channel" | "project" | "operator_cwd" | "task_default" | "legacy";
};
export type TaskWorkspacePendingSelection = {
  version: 1;
  requestKey: string;
  expectedBindingRevision: number;
  intent: TaskWorkspaceIntent;
};
