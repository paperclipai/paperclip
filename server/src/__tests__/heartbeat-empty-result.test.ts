// [PRACTICO-PATCH] Tests for empty result detection (#1117)
import { describe, expect, it } from "vitest";
import { isEmptyResult } from "../services/heartbeat.js";

describe("isEmptyResult", () => {
  // AC-1a: null → empty
  it("returns true for null", () => {
    expect(isEmptyResult(null)).toBe(true);
  });

  // AC-1b: undefined → empty
  it("returns true for undefined", () => {
    expect(isEmptyResult(undefined)).toBe(true);
  });

  // AC-1c: {} → empty
  it("returns true for empty object", () => {
    expect(isEmptyResult({})).toBe(true);
  });

  // AC-1d: all-empty-string values → empty
  it("returns true when all string values are empty", () => {
    expect(isEmptyResult({ summary: "", result: "" })).toBe(true);
  });

  // AC-2a: non-empty strings → not empty
  it("returns false for object with non-empty string values", () => {
    expect(isEmptyResult({ summary: "Completed 3 tasks", result: "ok" })).toBe(false);
  });

  // AC-2b: non-string values → not empty
  it("returns false for object with non-string values", () => {
    expect(isEmptyResult({ count: 5 })).toBe(false);
  });

  // AC-2c: mix of empty string + non-string → not empty
  it("returns false for mix of empty string and non-string value", () => {
    expect(isEmptyResult({ summary: "", count: 5 })).toBe(false);
  });

  // Edge: all-null values → empty
  it("returns true when all values are null", () => {
    expect(isEmptyResult({ summary: null, result: null })).toBe(true);
  });

  // Edge: boolean false is substantive
  it("returns false when a value is boolean false", () => {
    expect(isEmptyResult({ success: false })).toBe(false);
  });

  // Edge: numeric zero is substantive
  it("returns false when a value is zero", () => {
    expect(isEmptyResult({ count: 0 })).toBe(false);
  });
});

describe("heartbeat outcome — empty result integration", () => {
  // These tests validate the outcome logic documented in the plan.
  // The actual outcome evaluation is deeply embedded in the heartbeat
  // service async flow and requires full DB/adapter mocking. Here we
  // verify the logical composition: given the outcome override rule,
  // confirm the expected behavior for each scenario.

  function evaluateOutcome(input: {
    exitCode: number | null;
    errorMessage: string | null;
    timedOut: boolean;
    cancelled: boolean;
    resultJson: Record<string, unknown> | null | undefined;
  }): { outcome: string; errorCode: string | null; error: string | null; wakeupError: string | null } {
    // Replicate the exact logic from heartbeat.ts
    let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
    if (input.cancelled) {
      outcome = "cancelled";
    } else if (input.timedOut) {
      outcome = "timed_out";
    } else if ((input.exitCode ?? 0) === 0 && !input.errorMessage) {
      outcome = "succeeded";
    } else {
      outcome = "failed";
    }

    // [PRACTICO-PATCH] override with flag
    let emptyResultOverride = false;
    if (outcome === "succeeded" && isEmptyResult(input.resultJson)) {
      outcome = "failed";
      emptyResultOverride = true;
    }
    // [PRACTICO-PATCH] effectiveErrorMessage — shared by setRunStatus and setWakeupStatus
    const effectiveErrorMessage = emptyResultOverride
      ? "Agent exited successfully but produced no result"
      : (input.errorMessage ?? null);

    const errorCode =
      outcome === "timed_out"
        ? "timeout"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "failed"
            ? (emptyResultOverride ? "EMPTY_RESULT" : "adapter_failed")
            : null;

    const error =
      outcome === "succeeded"
        ? null
        : effectiveErrorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed");

    return { outcome, errorCode, error, wakeupError: effectiveErrorMessage };
  }

  // AC-1a-d: empty result → failed
  it("marks exit-0 with null resultJson as failed", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: null });
    expect(r.outcome).toBe("failed");
  });

  it("marks exit-0 with empty object resultJson as failed", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: {} });
    expect(r.outcome).toBe("failed");
  });

  it("marks exit-0 with all-empty-string resultJson as failed", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: { summary: "", result: "" } });
    expect(r.outcome).toBe("failed");
  });

  // AC-2a-c: non-empty result → succeeded
  it("marks exit-0 with non-empty resultJson as succeeded", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: { summary: "Completed 3 tasks", result: "ok" } });
    expect(r.outcome).toBe("succeeded");
  });

  it("marks exit-0 with numeric resultJson as succeeded", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: { count: 5 } });
    expect(r.outcome).toBe("succeeded");
  });

  // AC-3b: errorCode is EMPTY_RESULT
  it("sets errorCode to EMPTY_RESULT for empty-result failures", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: null });
    expect(r.errorCode).toBe("EMPTY_RESULT");
  });

  // AC-3a: error message is correct
  it("sets correct error message for empty-result failures", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: null });
    expect(r.error).toBe("Agent exited successfully but produced no result");
  });

  // Non-regression: real failures still use adapter_failed
  it("preserves adapter_failed errorCode for real failures", () => {
    const r = evaluateOutcome({ exitCode: 1, errorMessage: "crash", timedOut: false, cancelled: false, resultJson: null });
    expect(r.outcome).toBe("failed");
    expect(r.errorCode).toBe("adapter_failed");
    expect(r.error).toBe("crash");
  });

  // Non-regression: successful runs with result unchanged
  it("preserves succeeded with null errorCode for healthy runs", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: { summary: "done" } });
    expect(r.outcome).toBe("succeeded");
    expect(r.errorCode).toBeNull();
    expect(r.error).toBeNull();
  });

  // Wakeup status propagation: empty-result error reaches setWakeupStatus
  it("propagates empty-result error message to wakeup status", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: null });
    expect(r.wakeupError).toBe("Agent exited successfully but produced no result");
  });

  // Wakeup status: healthy run has null wakeup error
  it("returns null wakeup error for healthy runs", () => {
    const r = evaluateOutcome({ exitCode: 0, errorMessage: null, timedOut: false, cancelled: false, resultJson: { summary: "done" } });
    expect(r.wakeupError).toBeNull();
  });

  // Wakeup status: real adapter error propagates to wakeup
  it("propagates adapter error message to wakeup status", () => {
    const r = evaluateOutcome({ exitCode: 1, errorMessage: "crash", timedOut: false, cancelled: false, resultJson: { summary: "done" } });
    expect(r.wakeupError).toBe("crash");
  });
});
