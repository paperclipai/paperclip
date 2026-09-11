import type { InstanceExecutionMode } from "@paperclipai/shared";

/**
 * Whether the UI should offer the host-local "Login to Claude Code" action for
 * a `claude_local` agent that failed with `claude_auth_required`.
 *
 * `claude login` runs as a process on the server host and writes login state
 * to the host filesystem. When the instance execution policy forces all agent
 * execution onto the Kubernetes sandbox (`executionMode === "kubernetes"`),
 * sandboxed runs can never see that host-local state, so offering the login is
 * a dead end; the server refuses it with a 409 for the same reason. Mirrors
 * the server-side `claudeHostLoginUnavailableReason` guard. Pure so it can be
 * unit-tested without rendering.
 */
export function shouldOfferClaudeHostLogin(
  executionMode: InstanceExecutionMode | undefined,
): boolean {
  return executionMode !== "kubernetes";
}
