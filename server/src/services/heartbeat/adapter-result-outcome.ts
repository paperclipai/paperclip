import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunSessionOutcome } from "./run-state.js";

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
