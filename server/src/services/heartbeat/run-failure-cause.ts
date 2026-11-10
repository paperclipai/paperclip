import { normalizeRunFailureCause } from "@paperclipai/shared";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { safeErrorCauseCode } from "../../vendor/paperclip-runner/index.js";

/**
 * Bounded diagnosis for runs that settle with a generic failure code
 * (`adapter_failed`, `setup_failed`). The code stays generic because callers
 * compare against it; `resultJson.failureCause` names what went wrong with a
 * closed-shape token (see `@paperclipai/shared` run-failure-cause). It is
 * derived only from error codes, class names, provider HTTP status, process
 * exit facts and enum families, never from message text.
 */
export const GENERIC_RUN_FAILURE_CODES: ReadonlySet<string> = new Set(["adapter_failed", "setup_failed"]);

export const UNKNOWN_RUN_FAILURE_CAUSE = "unknown_error";

type ProviderFailureFacts = { httpStatus?: number; category?: string } | null | undefined;

/** A thrown failure: the provider's HTTP status or category, else the error's or its first three causes' code, else its class name. */
export function failureCauseFromError(error: unknown, providerFailure?: ProviderFailureFacts): string {
  const httpStatus = providerFailure?.httpStatus;
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599) {
    return `provider_http_${httpStatus}`;
  }
  const category = providerFailure?.category;
  if (category && category !== "unknown") {
    const cause = normalizeRunFailureCause(`provider_${category}`);
    if (cause) return cause;
  }
  return normalizeRunFailureCause(safeErrorCauseCode(error)) ?? UNKNOWN_RUN_FAILURE_CAUSE;
}

/** An adapter that returned a failed result without a named code: its error family, signal or exit code. */
export function failureCauseFromAdapterResult(
  result: Pick<AdapterExecutionResult, "errorFamily" | "signal" | "exitCode" | "errorMessage">,
  options: { processCancellationFailed?: boolean } = {},
): string {
  const family = normalizeRunFailureCause(result.errorFamily);
  if (family) return family;
  const signal = result.signal ? normalizeRunFailureCause(`signal_${result.signal}`) : null;
  if (signal) return signal;
  if (options.processCancellationFailed) return "process_cancellation_failed";
  if (typeof result.exitCode === "number" && Number.isInteger(result.exitCode) && result.exitCode !== 0) {
    return `exit_code_${result.exitCode}`;
  }
  if (result.errorMessage) return "adapter_reported_error";
  return UNKNOWN_RUN_FAILURE_CAUSE;
}
