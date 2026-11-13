import type { heartbeatRuns } from "@paperclipai/db";

/**
 * Run failure codes that only a person can resolve (the test for each: did a
 * person fail to do something, or did the system fail to carry it forward? Only
 * the first belongs here; e.g. a lost carry-over of a Retry's authorization,
 * `continuation_user_authorization_missing`, is the system's): they stopped the work, a
 * credential or access they must share, a configuration choice they must make,
 * a budget stop, or a provider usage limit that is waiting as designed. Every
 * other code, including codes that do not exist yet, gets the fallback.
 */
export const PERSON_OWNED_FAILURE_CODES = [
  // A person stopped or paused the work.
  "cancelled", "operator_cancelled", "operator_interrupted", "issue_cancelled", "issue_paused", "agent_paused",
  // A credential, secret or access the person must share.
  "configuration_incomplete", "slack_configuration_incomplete", "signing_secret_unconfigured",
  "user_secret_missing", "user_secret_definition_missing", "user_secret_definition_inactive",
  "github_access_denied", "github_repo_not_accessible", "github_auth_required", "project_access_denied",
  "permission_denied", "responsible_user_unauthorized", "oauth_access_projection_disabled",
  "acpx_auth_required", "codex_auth_required", "claude_auth_required", "provider_auth_failed", "hermes_gateway_auth_failed",
  // A configuration choice the person must change.
  "native_provider_model_rejected", "provider_tool_definition_invalid", "turn_limit_exhausted",
  // Budget stops.
  "budget_blocked", "budget_hard_stop", "budget_exceeded",
  // Provider usage limits that wait (and resume) as designed.
  "provider_quota", "provider_limit_wait", "native_provider_usage_limit",
  // An approval the person must give.
  "approval_required", "formal_approval_unavailable",
] as const;

export function isPersonOwnedFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && (PERSON_OWNED_FAILURE_CODES as readonly string[]).includes(code);
}

export const AUTOMATIC_CONTINUATION_WAKE_REASONS = [
  "issue_continuation_needed", "issue_assignment_recovery", "issue_recovery_action_restored", "transient_failure_retry",
] as const;
export function isAutomaticContinuationRun(run: Pick<typeof heartbeatRuns.$inferSelect, "retryOfRunId" | "scheduledRetryReason"
  | "contextSnapshot">): boolean {
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  if (context.explicitUserContinuation || context.wakeReason === "task_retry") return false;
  return Boolean(run.retryOfRunId || run.scheduledRetryReason || context.previousRunId || context.retryReason
    || context.freshContinuationIsolation
    || (AUTOMATIC_CONTINUATION_WAKE_REASONS as readonly unknown[]).includes(context.wakeReason));
}

export const PERMANENT_FAILURE_CODES = [
  "agent_interaction_delivery_denied", "adapter_engine_unavailable", "agent_not_invokable", "agent_not_found",
  "low_trust_isolation_unavailable", "low_trust_requires_isolated_workspace", "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment", "low_trust_runtime_services_denied",
] as const;

export function isSystemOwnedFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.length > 0 && !isPersonOwnedFailureCode(code)
    && !(PERMANENT_FAILURE_CODES as readonly string[]).includes(code);
}
