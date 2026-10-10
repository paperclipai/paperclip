import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

/** A successful CLI result is separate from stopping its remaining process group. */
export function isSuccessfulClaudeTerminalCleanup(
  adapterType: string,
  result: AdapterExecutionResult,
  processCancellationFailed = false,
): boolean {
  const parsed = result.resultJson;
  const cleanup = parsed?.unmanagedBackgroundTask;
  return adapterType === "claude_local" &&
    !result.timedOut && !result.errorCode && !result.errorMessage && !processCancellationFailed &&
    result.exitCode === 143 && (result.signal == null || result.signal === "SIGTERM") &&
    parsed?.subtype === "success" && parsed.is_error === false &&
    !parsed.error && (!parsed.errors || (Array.isArray(parsed.errors) && parsed.errors.length === 0)) &&
    Number(parsed.api_error_status ?? parsed.error_status ?? 0) < 400 &&
    cleanup != null && typeof cleanup === "object" && !Array.isArray(cleanup) &&
    (cleanup as Record<string, unknown>).kind === "terminal_result_cleanup" &&
    (cleanup as Record<string, unknown>).terminalResultSeen === true &&
    (cleanup as Record<string, unknown>).stopped === true &&
    (cleanup as Record<string, unknown>).signal === "SIGTERM" &&
    (cleanup as Record<string, unknown>).forceKilled === false;
}
