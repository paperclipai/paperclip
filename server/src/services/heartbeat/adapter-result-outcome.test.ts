import { describe, expect, it } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { isTerminalResultCleanupSuccess, resolveAdapterResultOutcome } from "./adapter-result-outcome.js";

const cleanupEvidence = {
  kind: "terminal_result_cleanup",
  stopped: true,
  stopReason: "unmanaged_background_task_stopped",
  reason: "unmanaged background task stopped; no durable live path",
  terminalResultSeen: true,
  signal: "SIGTERM",
  forceKilled: false,
};

function cleanupResult(overrides: Partial<AdapterExecutionResult> = {}, evidence: Record<string, unknown> = {}) {
  return {
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
    errorMessage: null,
    errorCode: null,
    terminalResultSuccess: true,
    resultJson: {
      unmanagedBackgroundTask: { ...cleanupEvidence, ...evidence },
    },
    ...overrides,
  } as AdapterExecutionResult;
}

describe("resolveAdapterResultOutcome: terminal-result cleanup", () => {
  it.each([
    ["signal SIGTERM recorded in the evidence", {}, {}],
    ["signal SIGKILL recorded in the evidence", { signal: "SIGKILL" as const }, { signal: "SIGKILL", forceKilled: true }],
    ["SIGTERM exit after cleanup escalated to SIGKILL for a child", {}, { signal: "SIGKILL", forceKilled: true }],
    ["exit 143", { exitCode: 143, signal: null }, {}],
    ["exit 137", { exitCode: 137, signal: null }, { signal: "SIGKILL", forceKilled: true }],
    ["exit 0", { exitCode: 0, signal: null }, {}],
  ])("records a clean result stopped by cleanup as succeeded (%s)", (_label, overrides, evidence) => {
    const result = cleanupResult(overrides, evidence);
    expect(isTerminalResultCleanupSuccess(result)).toBe(true);
    expect(resolveAdapterResultOutcome(result)).toBe("succeeded");
  });

  it.each([
    ["no cleanup evidence", { resultJson: {} }, {}],
    ["evidence not stopped", {}, { stopped: false }],
    ["terminal result not seen", {}, { terminalResultSeen: false }],
    ["adapter error message (error result)", { errorMessage: "Claude reported an error" }, {}],
    ["adapter error code", { errorCode: "claude_transient_upstream" }, {}],
    ["SIGKILL exit without SIGKILL in the evidence", { signal: "SIGKILL" as const }, { signal: "SIGTERM" }],
    ["evidence without a cleanup signal", {}, { signal: null }],
    ["signal that cleanup does not send", { signal: "SIGINT" as const }, { signal: "SIGINT" }],
    ["other non-zero exit", { exitCode: 1, signal: null }, {}],
  ])("keeps failed when %s", (_label, overrides, evidence) => {
    const result = cleanupResult(overrides as Partial<AdapterExecutionResult>, evidence);
    expect(isTerminalResultCleanupSuccess(result)).toBe(false);
    expect(resolveAdapterResultOutcome(result)).toBe("failed");
  });

  it.each([
    ["reports an unsuccessful terminal result", false],
    ["does not report a terminal result outcome", undefined],
  ])("keeps failed when the adapter %s", (_label, terminalResultSuccess) => {
    const result = cleanupResult({ terminalResultSuccess });
    expect(isTerminalResultCleanupSuccess(result)).toBe(false);
    expect(resolveAdapterResultOutcome(result)).toBe("failed");
  });

  it("decides from the adapter-reported result outcome, not provider result fields", () => {
    const result = cleanupResult();
    result.resultJson = { ...result.resultJson, subtype: "error_max_turns", is_error: true };
    expect(isTerminalResultCleanupSuccess(result)).toBe(true);
    expect(resolveAdapterResultOutcome(result)).toBe("succeeded");
  });

  it("keeps failed when a process cancellation failed", () => {
    const result = cleanupResult();
    expect(isTerminalResultCleanupSuccess(result, { processCancellationFailed: true })).toBe(false);
    expect(resolveAdapterResultOutcome(result, { processCancellationFailed: true })).toBe("failed");
  });

  it("keeps timed_out when the run timed out", () => {
    const result = cleanupResult({ timedOut: true });
    expect(isTerminalResultCleanupSuccess(result)).toBe(false);
    expect(resolveAdapterResultOutcome(result)).toBe("timed_out");
  });

  it("keeps cancelled when the result reports cancellation", () => {
    const result = cleanupResult({
      resultJson: { status: "cancelled", unmanagedBackgroundTask: cleanupEvidence },
    });
    expect(isTerminalResultCleanupSuccess(result)).toBe(false);
    expect(resolveAdapterResultOutcome(result)).toBe("cancelled");
  });

  it("leaves the generic exit-code rule unchanged without cleanup evidence", () => {
    expect(resolveAdapterResultOutcome({ exitCode: 0, signal: null, timedOut: false } as AdapterExecutionResult)).toBe("succeeded");
    expect(resolveAdapterResultOutcome({ exitCode: 143, signal: null, timedOut: false } as AdapterExecutionResult)).toBe("failed");
    expect(resolveAdapterResultOutcome({ exitCode: null, signal: "SIGTERM", timedOut: false } as AdapterExecutionResult)).toBe("failed");
  });
});
