import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunSessionOutcome } from "./run-state.js";

const TERMINAL_RESULT_CLEANUP_EXIT_CODES: ReadonlySet<number> = new Set([0, 143, 137]);
const TERMINAL_RESULT_CLEANUP_SIGNALS: ReadonlySet<string> = new Set(["SIGTERM", "SIGKILL"]);

/**
 * The CLI reported its terminal result and then lingered (a background task or
 * child kept it open), so the adapter's terminal-result cleanup stopped it. The
 * non-zero exit or signal is that cleanup's own termination, not a failure of
 * the turn. Only a clean result qualifies: any adapter error, timeout,
 * cancellation or failed process cancellation keeps the existing outcome.
 */
export function isTerminalResultCleanupSuccess(
  adapterResult: AdapterExecutionResult,
  options: { processCancellationFailed?: boolean } = {},
): boolean {
  const evidence = adapterResult.resultJson?.unmanagedBackgroundTask;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const cleanup = evidence as Record<string, unknown>;
  if (cleanup.stopped !== true || cleanup.terminalResultSeen !== true) return false;
  if (adapterResult.errorMessage || adapterResult.errorCode) return false;
  if (adapterResult.timedOut || options.processCancellationFailed) return false;
  if (adapterResult.resultJson?.status === "cancelled") return false;

  const { exitCode, signal } = adapterResult;
  if (signal) {
    return TERMINAL_RESULT_CLEANUP_SIGNALS.has(signal) && cleanup.signal === signal;
  }
  return exitCode !== null && exitCode !== undefined && TERMINAL_RESULT_CLEANUP_EXIT_CODES.has(exitCode);
}

/**
 * Run outcome derived from the adapter's own result, once the run is known not
 * to be already terminal and not aborted by the controller.
 */
export function resolveAdapterResultOutcome(
  adapterResult: AdapterExecutionResult,
  options: { processCancellationFailed?: boolean } = {},
): RunSessionOutcome {
  if (adapterResult.nativeFinalization) {
    const nativeTerminal = adapterResult.nativeFinalization.terminal.runTerminalState;
    return nativeTerminal === "succeeded"
      ? "succeeded"
      : nativeTerminal === "cancelled"
        ? "cancelled"
        : "failed";
  }
  if (adapterResult.timedOut) return "timed_out";
  if (adapterResult.resultJson?.status === "cancelled") return "cancelled";
  if (isTerminalResultCleanupSuccess(adapterResult, options)) return "succeeded";
  if (
    (adapterResult.exitCode ?? 0) === 0 &&
    !adapterResult.errorMessage &&
    !adapterResult.signal &&
    !options.processCancellationFailed
  ) {
    return "succeeded";
  }
  return "failed";
}
