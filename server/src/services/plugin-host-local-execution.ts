import { statSync } from "node:fs";
import type { WorkspaceProviderBinding } from "@paperclipai/shared";

/**
 * Local execution of plugin-storage workspaces.
 *
 * The runtime normally pairs a workspaceProvider binding with the native
 * plugin task bridge: the provider's own environment must realize and reach
 * the workspace, so `workspaceRef` stays a durable logical address and Core
 * never resolves it on the host (`environment-run-orchestrator` hard-gates
 * bound workspaces to the `plugin` driver). A self-hosted deployment can run
 * a pure storage plugin whose `workspaceRef` names a real host directory (for
 * example a wt claim tree under `<repo>/.worktree/<name>`). For that
 * deployment the runtime lets the workspace execute in place on the `local`
 * driver instead of refusing.
 *
 * Decision contract:
 * - The environment driver must be `local`. The `plugin` driver keeps the
 *   plugin task bridge, and remote drivers never host the workspace.
 * - The binding `workspaceRef` must be an absolute path naming an existing
 *   directory on this host. Cloud providers hand back opaque refs
 *   (`provider:<name>`), which never satisfy the shape check, so this contract
 *   only opens for storage plugins that deliberately manage host trees.
 *
 * The same predicate feeds all three consumers so they cannot disagree:
 * the orchestrator execution gates, the realized workspace synthesis
 * (`heartbeat/workspace-preparation`), and the preparation row `cwd` backfill
 * (`plugin-workspaces`). A workspace whose tree disappeared on this host is
 * `blocked`, which surfaces as a repair action instead of the plugin-bridge
 * error.
 */

export type PluginWorkspaceHostExecutionReason =
  | "workspace_ref_not_host_path"
  | "workspace_ref_missing";

export type PluginWorkspaceHostExecutionDecision =
  | { kind: "host"; workspaceRef: string }
  | { kind: "plugin" }
  | { kind: "blocked"; reason: PluginWorkspaceHostExecutionReason };

/**
 * True when the workspaceRef names an existing directory on this host and can
 * be executed in place. Returns the ref so callers reuse the resolved value.
 */
export function pluginWorkspaceHostRef(workspaceRef: string): string | null {
  if (!workspaceRef.startsWith("/")) return null;
  try {
    if (!statSync(workspaceRef).isDirectory()) return null;
  } catch {
    return null;
  }
  return workspaceRef;
}

/**
 * Decide whether a provider-bound workspace executes on the host's local
 * driver in place (`host`), on the provider's own plugin task bridge
 * (`plugin`), or cannot execute at all (`blocked`).
 */
export function decidePluginWorkspaceHostExecution(
  binding: WorkspaceProviderBinding,
  environmentDriver: string | null | undefined,
): PluginWorkspaceHostExecutionDecision {
  if (environmentDriver !== "local") return { kind: "plugin" };
  if (!binding.workspaceRef.startsWith("/")) {
    return { kind: "blocked", reason: "workspace_ref_not_host_path" };
  }
  const workspaceRef = pluginWorkspaceHostRef(binding.workspaceRef);
  return workspaceRef
    ? { kind: "host", workspaceRef }
    : { kind: "blocked", reason: "workspace_ref_missing" };
}
