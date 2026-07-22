import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

// REW-34 / REW-30 spec #4 (auto-retry before escalate). The REW-29 root cause was
// that ACP engine run/turn deaths (`acpx_turn_failed`) stranded an assigned issue
// and were escalated to a human after a single attempt with no automatic retry.
// These codes must classify as a bounded, backed-off retryable failure so the
// stranded-issue sweep re-enqueues the continuation N times before escalating.
describe("acpx run-failure continuation retry classification (REW-34)", () => {
  it("acpx_turn_failed is a bounded-retry run failure, not an immediate escalation", () => {
    const c = classifyContinuationFailure(run("acpx_turn_failed"));
    expect(c.kind).toBe("run_failure");
    // Bounded retry budget > 1 attempt (a single-attempt `default` was the bug).
    expect(c.maxAttempts).toBeGreaterThan(1);
    // Exponential backoff needs a positive base delay to space out retries.
    expect(c.baseBackoffMs).toBeGreaterThan(0);
    expect(c.errorCode).toBe("acpx_turn_failed");
  });

  it("acpx_timeout (turn timeout) is treated the same bounded-retry way", () => {
    const c = classifyContinuationFailure(run("acpx_timeout"));
    expect(c.kind).toBe("run_failure");
    expect(c.maxAttempts).toBeGreaterThan(1);
    expect(c.baseBackoffMs).toBeGreaterThan(0);
  });

  it("run-failure retry budget/backoff matches the transient-infra budget", () => {
    const runFailure = classifyContinuationFailure(run("acpx_turn_failed"));
    const transient = classifyContinuationFailure(run("timeout"));
    expect(runFailure.maxAttempts).toBe(transient.maxAttempts);
    expect(runFailure.baseBackoffMs).toBe(transient.baseBackoffMs);
  });

  it("does not disturb existing classifications", () => {
    // Regression guards so the new branch stays scoped to the two ACP codes.
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
    expect(classifyContinuationFailure(run("timeout")).kind).toBe("transient_infra");
    expect(classifyContinuationFailure(run("cancelled")).kind).toBe("default");
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });
});
