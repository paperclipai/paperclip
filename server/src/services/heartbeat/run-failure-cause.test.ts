import { describe, expect, it } from "vitest";
import { normalizeRunFailureCause } from "@paperclipai/shared";
import { failureCauseFromAdapterResult, failureCauseFromError, isNativePreDispatchTransientFailure } from "./run-failure-cause.js";

describe("run failure cause", () => {
  it("reads the first safe code from the error and at most three nested causes", () => {
    const wrap = (cause: unknown, depth: number): unknown => depth === 0 ? cause : new Error(`wrapper ${depth}`, { cause: wrap(cause, depth - 1) });
    expect(failureCauseFromError(wrap({ code: "ECONNRESET" }, 3))).toBe("ECONNRESET");
    // A fourth nested cause is outside the bound: the outer class name is used.
    expect(failureCauseFromError(wrap({ code: "ECONNRESET" }, 4))).toBe("Error");
    expect(failureCauseFromError(Object.assign(new Error("x"), { code: "40001" }))).toBe("40001");
  });

  it("prefers the provider's HTTP status, then its category", () => {
    expect(failureCauseFromError(new Error("x"), { httpStatus: 429, category: "rate_limit" })).toBe("provider_http_429");
    expect(failureCauseFromError(new Error("x"), { category: "authentication" })).toBe("provider_authentication");
    expect(failureCauseFromError(new TypeError("x"), { category: "unknown" })).toBe("TypeError");
  });

  it("never returns message text and falls back for non-errors", () => {
    expect(failureCauseFromError({ code: "relation \"users\" does not exist" })).toBe("object");
    expect(failureCauseFromError("Failed query: select 1")).toBe("string");
    expect(failureCauseFromError(Object.assign(new Error("x"), { name: "bad name with spaces" }))).toBe("unknown_error");
    for (const value of [null, undefined, 42, new RangeError("y")]) {
      expect(normalizeRunFailureCause(failureCauseFromError(value))).not.toBeNull();
    }
  });

  it("names adapter results by family, signal, cancellation, exit code, or reported error", () => {
    const base = { errorFamily: null, signal: null, exitCode: 0, errorMessage: null };
    expect(failureCauseFromAdapterResult({ ...base, errorFamily: "transient_upstream", exitCode: 1 })).toBe("transient_upstream");
    expect(failureCauseFromAdapterResult({ ...base, signal: "SIGKILL", exitCode: 137 })).toBe("signal_SIGKILL");
    expect(failureCauseFromAdapterResult(base, { processCancellationFailed: true })).toBe("process_cancellation_failed");
    expect(failureCauseFromAdapterResult({ ...base, exitCode: 2 })).toBe("exit_code_2");
    expect(failureCauseFromAdapterResult({ ...base, errorMessage: "select * from secrets where id = $1" })).toBe("adapter_reported_error");
    expect(failureCauseFromAdapterResult(base)).toBe("unknown_error");
  });

  it("re-queues only a recorded native pre-dispatch failure with a transient database cause", () => {
    const record = { version: 1, providerWorkStarted: false };
    const run = { runtimeMode: "native", status: "failed", errorCode: "adapter_failed",
      resultJson: { failureCause: "40001", nativePreDispatchFailure: record } };
    expect(isNativePreDispatchTransientFailure(run)).toBe(true);
    expect(isNativePreDispatchTransientFailure({ ...run, errorCode: "setup_failed", resultJson: { failureCause: "57P01", nativePreDispatchFailure: record } })).toBe(true);
    // A row saved by an older server has no record and keeps the native hold.
    expect(isNativePreDispatchTransientFailure({ ...run, resultJson: { failureCause: "40001" } })).toBe(false);
    expect(isNativePreDispatchTransientFailure({ ...run, resultJson: { failureCause: "40001",
      nativePreDispatchFailure: { version: 1, providerWorkStarted: true } } })).toBe(false);
    expect(isNativePreDispatchTransientFailure({ ...run, resultJson: { failureCause: "Error", nativePreDispatchFailure: record } })).toBe(false);
    expect(isNativePreDispatchTransientFailure({ ...run, errorCode: "native_session_interrupted" })).toBe(false);
    expect(isNativePreDispatchTransientFailure({ ...run, runtimeMode: "legacy" })).toBe(false);
    expect(isNativePreDispatchTransientFailure({ ...run, status: "cancelled" })).toBe(false);
  });
});
