/** Native terminal codes eligible for receipted, fresh-conversation pool recovery. */
export const NATIVE_POOL_FAILURE_CODES = ["native_provider_usage_limit", "native_provider_auth_failed", "native_provider_runner_failed"];
export const DEFINITIVE_NATIVE_RUNNER_FAILURE_CODES = ["native_runner_process_exited", "provider_process_exited", "provider_stdout_closed", "provider_process_output_closed", "provider_process_status_failed"];
export function nativePoolFailureKind(code: string | null | undefined): "quota" | "auth" | "runner" | null {
  return code === "native_provider_usage_limit" ? "quota" : code === "native_provider_auth_failed" ? "auth" : code === "native_provider_runner_failed" ? "runner" : null;
}
