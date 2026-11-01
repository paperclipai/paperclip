import type { Db, executionWorkspaces } from "@paperclipai/db";
import { finalizePluginWorkspace, type WorkspaceWorkers } from "../plugin-workspaces.js";

/** Validate retained plugin files without interpreting a provider reference as a Core path. */
export async function inspectPluginWorkspaceForFinalization(
  db: Db,
  workers: WorkspaceWorkers | undefined,
  workspace: typeof executionWorkspaces.$inferSelect,
  agentId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  if (workspace.providerType === "plugin") {
    const inspection = await finalizePluginWorkspace(db, workers, workspace, { agentId, runId });
    if (workspace.strategyType === "git_worktree"
      && (!workspace.branchName || inspection.branchName !== workspace.branchName)) {
      throw new Error("plugin_workspace_branch_mismatch");
    }
    return { providerType: workspace.providerType, inspection };
  }
  const owner = workspace.metadata?.runnerTaskWorkspaceOwner;
  if (workspace.providerType === "adapter_managed" && owner && typeof owner === "object" && !Array.isArray(owner)) {
    if ((owner as Record<string, unknown>).agentId !== agentId) throw new Error("plugin_workspace_owner_mismatch");
    return { providerType: workspace.providerType, owner };
  }
  return null;
}
