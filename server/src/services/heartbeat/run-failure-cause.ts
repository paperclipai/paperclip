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

/**
 * Durable record on a failed native run that no provider work could have
 * started: the controller never entered the dispatch gate, the run was not a
 * resumed restart claim, and the run's whole history has no native coordinator
 * and no execution-start evidence (`native.process_start_requested` among them).
 * Rows saved before this record existed have none and keep the native hold.
 */
export const NATIVE_PRE_DISPATCH_FAILURE_KEY = "nativePreDispatchFailure";
/** Failure code on the unclaimed native coordinator that such a failure closes. */
export const NATIVE_PRE_DISPATCH_FAILURE_CODE = "native_pre_dispatch_failure";
export const NATIVE_PRE_DISPATCH_FAILURE_RECORD = Object.freeze({ version: 1, providerWorkStarted: false } as const);

export function hasNativePreDispatchFailureRecord(resultJson: unknown): boolean {
  if (typeof resultJson !== "object" || resultJson === null || Array.isArray(resultJson)) return false;
  const record = (resultJson as Record<string, unknown>)[NATIVE_PRE_DISPATCH_FAILURE_KEY];
  if (typeof record !== "object" || record === null) return false;
  const fields = record as Record<string, unknown>;
  return fields.version === 1 && fields.providerWorkStarted === false;
}

/**
 * Database faults that clear on their own: serialization and deadlock aborts,
 * a lock timeout, an administrator or crash shutdown, too many connections and
 * a dropped connection (SQLSTATEs and postgres.js codes). Storage outages keep
 * their own wait lane (`storage_unavailable`).
 */
const TRANSIENT_PRE_DISPATCH_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "40001", "40P01", "55P03", "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08006",
  "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
]);

/**
 * A failed native run that may re-queue itself without a person: it carries the
 * pre-dispatch record, a generic failure code and a transient database cause.
 * Anything else keeps the native hold and its manual Retry.
 */
export function isNativePreDispatchTransientFailure(run: {
  runtimeMode: string | null; status: string; errorCode: string | null; resultJson: unknown;
}): boolean {
  if (run.runtimeMode !== "native" || run.status !== "failed" || !run.errorCode
    || !GENERIC_RUN_FAILURE_CODES.has(run.errorCode) || !hasNativePreDispatchFailureRecord(run.resultJson)) return false;
  const cause = normalizeRunFailureCause((run.resultJson as Record<string, unknown>).failureCause);
  return cause !== null && TRANSIENT_PRE_DISPATCH_FAILURE_CAUSES.has(cause);
}
