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
    resultJson: {
      type: "result",
      subtype: "success",
      stop_reason: "end_turn",
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
    ["no cleanup evidence", { resultJson: { type: "result", subtype: "success" } }, {}],
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
    ["error_max_turns reported without is_error", { subtype: "error_max_turns", is_error: false }],
    ["error_during_execution reported without is_error", { subtype: "error_during_execution", is_error: false }],
    ["an empty subtype", { subtype: "  " }],
    ["is_error true with a success subtype", { subtype: "success", is_error: true }],
    ["is_error true without a subtype", { subtype: undefined, is_error: true }],
  ])("keeps failed when the result is not a clean success: %s", (_label, fields) => {
    const result = cleanupResult();
    result.resultJson = { ...result.resultJson, ...fields };
    expect(isTerminalResultCleanupSuccess(result)).toBe(false);
    expect(resolveAdapterResultOutcome(result)).toBe("failed");
  });

  it.each([
    ["a success subtype with surrounding space and capitals", { subtype: " Success " }],
    ["no subtype (generic adapter result)", { subtype: undefined }],
    ["a non-string subtype", { subtype: 1 }],
  ])("records succeeded for %s", (_label, fields) => {
    const result = cleanupResult();
    result.resultJson = { ...result.resultJson, ...fields };
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
