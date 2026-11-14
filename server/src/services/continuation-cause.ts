import { sql, type SQL } from "drizzle-orm";
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

export const PERMANENT_FAILURE_CODES = [
  "agent_interaction_delivery_denied", "adapter_engine_unavailable", "agent_not_invokable", "agent_not_found",
  "low_trust_isolation_unavailable", "low_trust_requires_isolated_workspace", "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment", "low_trust_runtime_services_denied",
] as const;

export const RESTART_CLASS_FAILURE_CODES = [
  "native_restart_recovery_blocked", "native_continuation_requires_reconciliation", "native_session_interrupted",
  "native_runner_process_exited", "server_shutdown_interrupted", "process_lost", "controller_lease_lost",
  "execution_finalization_deadline_exceeded", "local_runtime_api_listener_unavailable",
  "runner_remote_process_identity_unavailable", "continuation_user_authorization_missing",
] as const;

const REUSABLE_SANDBOX_RESUME_FAILED = "reusable_sandbox_resume_failed";
const TRANSIENT_SANDBOX_CAUSES = ["transport_timeout", "transport_closed", "sandbox_state_transition", "provider_rate_limited",
  "provider_unavailable"] as const;
const EXTERNAL_STOP_UNCONFIRMED_PROVIDERS = ["openai_dot", "muse"] as const;
const UNFINISHED_RUN_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"];

type ClassifiedRun = Pick<typeof heartbeatRuns.$inferSelect, "status" | "errorCode" | "retryOfRunId" | "scheduledRetryReason"
  | "contextSnapshot"> & { error?: string | null; runnerProfileJson?: unknown; resultJson?: unknown };

const TRANSIENT_SETUP_FAILURE_CODES = [
  REUSABLE_SANDBOX_RESUME_FAILED, "remote_workspace_prepare_timeout", "environment_provider_unavailable",
  "workspace_git_scan_timeout", "workspace_git_scan_saturated", "repository_catalog_unavailable",
] as const;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function isSystemOwnedFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && code.length > 0 && !isPersonOwnedFailureCode(code)
    && !(PERMANENT_FAILURE_CODES as readonly string[]).includes(code);
}

export function continuationCauseIsSystemOwned(run: Pick<ClassifiedRun, "status" | "errorCode" | "error" | "runnerProfileJson">): boolean {
  if (!UNFINISHED_RUN_STATUSES.includes(run.status) || !isSystemOwnedFailureCode(run.errorCode)) return false;
  const provider = object(object(object(run.runnerProfileJson).nativeExecutionInput).provider).kind;
  if ((EXTERNAL_STOP_UNCONFIRMED_PROVIDERS as readonly unknown[]).includes(provider)) return false;
  if (run.errorCode !== REUSABLE_SANDBOX_RESUME_FAILED) return true;
  const cause = /\(cause=([a-z_]+)/.exec(run.error ?? "")?.[1];
  return cause !== undefined && (TRANSIENT_SANDBOX_CAUSES as readonly string[]).includes(cause);
}

export function isRecoveryRun(run: Pick<ClassifiedRun, "retryOfRunId" | "scheduledRetryReason" | "contextSnapshot">): boolean {
  const context = object(run.contextSnapshot);
  if (context.explicitUserContinuation || context.wakeReason === "task_retry") return false;
  return Boolean(run.retryOfRunId || run.scheduledRetryReason || context.previousRunId || context.retryReason
    || context.freshContinuationIsolation
    || (AUTOMATIC_CONTINUATION_WAKE_REASONS as readonly unknown[]).includes(context.wakeReason));
}

export function canContinueRecoveryRunAutomatically(run: ClassifiedRun): boolean {
  return continuationCauseIsSystemOwned(run) && isRecoveryRun(run);
}

function firstRunFailureContinues(run: Pick<ClassifiedRun, "errorCode" | "resultJson">): boolean {
  if (isRestartClassFailureCode(run.errorCode)) return true;
  const recovery = object(object(run.resultJson).executionRecovery);
  return (TRANSIENT_SETUP_FAILURE_CODES as readonly unknown[]).includes(run.errorCode)
    && recovery.kind === "bootstrap" && recovery.providerWorkStarted === false;
}

export function continuesAutomatically(run: ClassifiedRun): boolean {
  return continuationCauseIsSystemOwned(run) && (isRecoveryRun(run) || firstRunFailureContinues(run));
}

export function isRestartClassFailureCode(code: string | null | undefined): boolean {
  return typeof code === "string" && (RESTART_CLASS_FAILURE_CODES as readonly string[]).includes(code);
}

const list = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);

export function continuationCauseIsSystemOwnedSql(alias: string): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  const code = column("error_code");
  return sql`(${column("status")} in (${list(UNFINISHED_RUN_STATUSES)}) and ${code} is not null and ${code} <> ''
    and ${code} not in (${list([...PERSON_OWNED_FAILURE_CODES, ...PERMANENT_FAILURE_CODES])})
    and coalesce(${column("runner_profile_json")}#>>'{nativeExecutionInput,provider,kind}', '') not in (${list(EXTERNAL_STOP_UNCONFIRMED_PROVIDERS)})
    and (${code} <> ${REUSABLE_SANDBOX_RESUME_FAILED}
      or substring(coalesce(${column("error")}, '') from '\\(cause=([a-z_]+)') in (${list(TRANSIENT_SANDBOX_CAUSES)})))`;
}

export function recoveryRunSql(alias: string): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  const context = column("context_snapshot");
  return sql`(not coalesce(${context} ? 'explicitUserContinuation', false)
    and coalesce(${context}->>'wakeReason', '') <> 'task_retry'
    and (${column("retry_of_run_id")} is not null or ${column("scheduled_retry_reason")} is not null
      or ${context} ? 'previousRunId' or ${context} ? 'retryReason' or ${context} ? 'freshContinuationIsolation'
      or ${context}->>'wakeReason' in (${list(AUTOMATIC_CONTINUATION_WAKE_REASONS)})))`;
}

export function continuesAutomaticallySql(alias: string): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return sql`(${continuationCauseIsSystemOwnedSql(alias)} and (${recoveryRunSql(alias)}
    or ${column("error_code")} in (${list(RESTART_CLASS_FAILURE_CODES)})
    or (${column("error_code")} in (${list(TRANSIENT_SETUP_FAILURE_CODES)})
      and ${column("result_json")}#>>'{executionRecovery,kind}' = 'bootstrap'
      and ${column("result_json")}#>>'{executionRecovery,providerWorkStarted}' = 'false')))`;
}
