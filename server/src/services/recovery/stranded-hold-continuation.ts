import { REUSABLE_SANDBOX_RESUME_FAILED_CODE } from "../reusable-sandbox-resume-error.js";

export const STRANDED_CONTINUATION_MAX_AGE_MS = 24 * 60 * 60_000;
export const STRANDED_KIND = "stranded_assigned_issue";

const RESTART_CLASS_CODES = new Set([
  "process_lost", "server_shutdown_interrupted", "controller_lease_lost", "native_session_interrupted",
  "native_runner_process_exited", "execution_finalization_deadline_exceeded", "local_runtime_api_listener_unavailable",
]);

const TRANSIENT_SETUP_CODES = new Set([
  REUSABLE_SANDBOX_RESUME_FAILED_CODE, "remote_workspace_prepare_timeout", "environment_provider_unavailable",
  "workspace_git_scan_timeout", "workspace_git_scan_saturated", "repository_catalog_unavailable",
]);

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
  if (now.getTime() - run.finishedAt.getTime() > STRANDED_CONTINUATION_MAX_AGE_MS) return false;
  return strandedRunCauseIsTemporary(run);
}

export function strandedRunCauseIsTemporary(
  run: Pick<StrandedHoldRun, "status" | "errorCode" | "error" | "executionRecovery">,
): boolean {
  if (!["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)) return false;
  const code = run.errorCode ?? "";
  if (RESTART_CLASS_CODES.has(code)) return true;
  if (!TRANSIENT_SETUP_CODES.has(code)) return false;
  if (run.executionRecovery?.kind !== "bootstrap" || run.executionRecovery.providerWorkStarted !== false) return false;
  if (code !== REUSABLE_SANDBOX_RESUME_FAILED_CODE) return true;
  const cause = /\(cause=([a-z_]+)/.exec(run.error ?? "")?.[1];
  return cause !== undefined && TRANSIENT_SANDBOX_CAUSES.has(cause);
}
