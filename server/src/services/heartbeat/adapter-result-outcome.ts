import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunSessionOutcome } from "./run-state.js";

const TERMINAL_RESULT_CLEANUP_EXIT_CODES: ReadonlySet<number> = new Set([0, 143, 137]);

export function isTerminalResultCleanupSuccess(
  adapterResult: AdapterExecutionResult,
  options: { processCancellationFailed?: boolean } = {},
): boolean {
  const evidence = adapterResult.resultJson?.unmanagedBackgroundTask;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const cleanup = evidence as Record<string, unknown>;
  if (cleanup.stopped !== true || cleanup.terminalResultSeen !== true) return false;
  if (adapterResult.terminalResultSuccess !== true) return false;
  if (adapterResult.errorMessage || adapterResult.errorCode) return false;
  if (adapterResult.timedOut || options.processCancellationFailed) return false;
  if (adapterResult.resultJson?.status === "cancelled") return false;

  const { exitCode, signal } = adapterResult;
  if (signal) {
    if (signal === "SIGTERM") return cleanup.signal === "SIGTERM" || cleanup.signal === "SIGKILL";
    if (signal === "SIGKILL") return cleanup.signal === "SIGKILL";
    return false;
  }
  return exitCode !== null && exitCode !== undefined && TERMINAL_RESULT_CLEANUP_EXIT_CODES.has(exitCode);
}

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
