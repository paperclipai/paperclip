import type { WorkspaceRealizationRequest } from "./types.js";
import { executeProjectPrimaryClone, type GitCloneDeps } from "./git-clone.js";
import { executeGitWorktree, type GitWorktreeDeps } from "./git-worktree.js";

export interface ExecuteStrategyDeps extends GitCloneDeps, GitWorktreeDeps {}

export async function executeWorkspaceStrategy(
  request: WorkspaceRealizationRequest,
  root: string,
  deps: ExecuteStrategyDeps,
): Promise<void> {
  switch (request.source.strategy) {
    case "project_primary":
      return executeProjectPrimaryClone(request, root, deps);
    case "git_worktree":
      return executeGitWorktree(request, root, deps);
    // adapter_managed / cloud_sandbox are no-ops in the init container —
    // those adapters set up the workspace inside their own container.
    default:
      return;
  }
}
