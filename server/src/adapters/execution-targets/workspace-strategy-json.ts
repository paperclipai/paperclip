// Builds the JSON payload the K8s init container receives via the
// PAPERCLIP_WORKSPACE_REQUEST env var. The wire contract is enforced by
// tools/workspace-init/src/parse-request.ts: version must be 1 and
// source.strategy must be a string.
//
// executeWorkspaceStrategy in @paperclipai/workspace-strategy dispatches on
// source.strategy and only does work for "project_primary" and
// "git_worktree". Any other value is treated as a no-op — exactly what we
// want for M2 where claude_local manages its own working directory inside
// the main container. M3+ will replace this with a real
// WorkspaceRealizationRequest built from per-run inputs.

export function buildAdapterManagedWorkspaceRequestJson(): string {
  return JSON.stringify({
    version: 1,
    source: { strategy: "adapter_managed" },
  });
}
