import type { ExecutionWorkspaceMode, Issue } from "@paperclipai/shared";
import {
  defaultExecutionWorkspaceModeForProject,
  issueExecutionWorkspaceModeForExistingWorkspace,
} from "./project-workspace-defaults";

export type IssueWorkspaceSelection = ExecutionWorkspaceMode | "reuse_existing" | null;

type IssueWorkspaceSelectionSource = Pick<
  Issue,
  | "executionWorkspaceId"
  | "executionWorkspacePreference"
  | "executionWorkspaceSettings"
  | "currentExecutionWorkspace"
>;

type ProjectWorkspaceSelectionSource = Parameters<typeof defaultExecutionWorkspaceModeForProject>[0];

export interface WorkspaceSelectionUpdate extends Record<string, unknown> {
  executionWorkspacePreference: IssueWorkspaceSelection;
  executionWorkspaceId: string | null;
  executionWorkspaceSettings: {
    mode: ExecutionWorkspaceMode;
    environmentId: null;
  } | null;
}

/**
 * Resolves the issue's effective workspace choice. A bound isolated or operator
 * workspace is always presented as reuse-existing, even if its persisted
 * preference still describes how it was originally created.
 */
export function currentWorkspaceSelection(
  issue: IssueWorkspaceSelectionSource,
  project: ProjectWorkspaceSelectionSource,
): IssueWorkspaceSelection {
  const persistedMode =
    issue.currentExecutionWorkspace?.mode
    ?? issue.executionWorkspaceSettings?.mode
    ?? issue.executionWorkspacePreference;

  if (
    issue.executionWorkspaceId
    && (persistedMode === "isolated_workspace" || persistedMode === "operator_branch")
  ) {
    return "reuse_existing";
  }

  return (
    issue.executionWorkspacePreference
    ?? issue.executionWorkspaceSettings?.mode
    ?? defaultExecutionWorkspaceModeForProject(project)
  ) as IssueWorkspaceSelection;
}

/** Returns null when the selection is incomplete and cannot be saved. */
export function buildWorkspaceSelectionUpdate(
  selection: IssueWorkspaceSelection,
  workspaceId: string | null | undefined,
  reusedWorkspaceMode: string | null | undefined,
): WorkspaceSelectionUpdate | null {
  if (selection === "reuse_existing" && !workspaceId) return null;

  if (selection === null) {
    return {
      executionWorkspacePreference: null,
      executionWorkspaceId: null,
      executionWorkspaceSettings: null,
    };
  }

  return {
    executionWorkspacePreference: selection,
    executionWorkspaceId: selection === "reuse_existing" ? workspaceId! : null,
    executionWorkspaceSettings: {
      mode: selection === "reuse_existing"
        ? issueExecutionWorkspaceModeForExistingWorkspace(reusedWorkspaceMode)
        : selection,
      environmentId: null,
    },
  };
}
