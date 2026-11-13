import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "../reusable-sandbox-resume-error.js";

/**
 * Which board-owned stranded-work escalations the assigned-work sweep
 * continues instead of leaving them for a person.
 *
 * Stranded-work recovery escalates to the board whenever a task's bounded
 * retries run out, whatever the cause. "Owned by the board" is a routing
 * policy, not evidence that a person has anything to do: when the run that
 * ran out failed for a temporary reason before any provider work (a sandbox
 * that timed out resuming, a server restart), the next attempt needs nothing
 * from anyone. Only RECENT escalations qualify: the failed run ended within
 * STRANDED_CONTINUATION_MAX_AGE_MS. Older ones are history and stay as they
 * are for a person's Retry.
 *
 * The sweep is the single owner of these holds: the fresh-continuation
 * fallback never takes a stranded_assigned_issue hold (its cause is not an
 * execution-reconciliation cause), and the sweep's per-task cap and spacing
 * bound the continuations.
 */
export const STRANDED_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const STRANDED_KIND = "stranded_assigned_issue";

/** A server restart, deploy or lost process ended the run. */
const RESTART_CLASS_CODES = new Set([
  "process_lost", "server_shutdown_interrupted", "controller_lease_lost", "native_session_interrupted",
  "native_runner_process_exited", "execution_finalization_deadline_exceeded", "local_runtime_api_listener_unavailable",
]);

/** Setup failures that are temporary when they happened before provider work. */
const TRANSIENT_SETUP_CODES = new Set([
  REUSABLE_SANDBOX_RESUME_FAILED_CODE, "remote_workspace_prepare_timeout", "environment_provider_unavailable",
  "workspace_git_scan_timeout", "workspace_git_scan_saturated", "repository_catalog_unavailable",
]);

/** Sandbox-provider refusals that pass by themselves (remote-workspace-transport labels). */
const TRANSIENT_SANDBOX_CAUSES = new Set([
  "transport_timeout", "transport_closed", "sandbox_state_transition", "provider_rate_limited", "provider_unavailable",
]);

export type StrandedHoldRun = {
  agentId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  finishedAt: Date | null;
  executionRecovery: { kind?: unknown; providerWorkStarted?: unknown } | null;
};

export function strandedHoldContinuesAutomatically(
  hold: { kind: string; ownerType: string },
  run: StrandedHoldRun | null,
  assigneeAgentId: string | null,
  now: Date,
): boolean {
  if (hold.kind !== STRANDED_KIND || hold.ownerType !== "board") return false;
  if (!run || !assigneeAgentId || run.agentId !== assigneeAgentId || !run.finishedAt) return false;
  if (!["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)) return false;
  if (now.getTime() - run.finishedAt.getTime() > STRANDED_CONTINUATION_MAX_AGE_MS) return false;
  const code = run.errorCode ?? "";
  if (RESTART_CLASS_CODES.has(code)) return true;
  if (!TRANSIENT_SETUP_CODES.has(code)) return false;
  if (run.executionRecovery?.kind !== "bootstrap" || run.executionRecovery.providerWorkStarted !== false) return false;
  if (code !== REUSABLE_SANDBOX_RESUME_FAILED_CODE) return true;
  // A saved sandbox that is lost or refused access is not temporary; the
  // resume error names the provider's refusal with a closed label.
  const cause = /\(cause=([a-z_]+)/.exec(run.error ?? "")?.[1];
  return cause !== undefined && TRANSIENT_SANDBOX_CAUSES.has(cause);
}
