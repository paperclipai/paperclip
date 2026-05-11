import type { WorkspaceRealizationRequest } from "@paperclipai/workspace-strategy";

// Validates the PAPERCLIP_WORKSPACE_REQUEST env var the init container
// receives. The shape is the wire contract between any caller that schedules
// a K8s agent run (today: server/src/index.ts resolveRunContext) and this
// init container; both ends must agree on `version` and `source.strategy`.
//
// Kept loose on purpose: the init container forwards everything else to
// executeWorkspaceStrategy, which dispatches on `source.strategy` and
// no-ops for anything outside {"project_primary", "git_worktree"}.
export function parseRequest(json: string): WorkspaceRealizationRequest {
  const parsed = JSON.parse(json) as WorkspaceRealizationRequest;
  if (parsed.version !== 1) {
    throw new Error(`PAPERCLIP_WORKSPACE_REQUEST: unsupported version ${parsed.version}`);
  }
  if (!parsed.source || typeof parsed.source.strategy !== "string") {
    throw new Error("PAPERCLIP_WORKSPACE_REQUEST: missing source.strategy");
  }
  return parsed;
}
