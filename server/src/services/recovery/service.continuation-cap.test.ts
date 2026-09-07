import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

// MAS-93 defect 3: the error codes that actually produce retry storms were landing in
// the `default` class, which returns baseBackoffMs 0. A server restart loses every live
// run at once, so an uncapped, un-backed-off retry on these codes is what turned one
// SIGTERM into 84 retries in 20 minutes.
describe("continuation retry classification: host-fault codes", () => {
  const hostFaultCodes = [
    "process_lost",
    "process_detached",
    "acpx_turn_failed",
    "server_shutdown_interrupted",
    "orphaned_running_run",
  ];

  for (const code of hostFaultCodes) {
    it(`classifies ${code} as host_fault with a bounded cap and non-zero backoff`, () => {
      const c = classifyContinuationFailure(run(code));
      expect(c.kind).toBe("host_fault");
      expect(c.errorCode).toBe(code);
      // A bound must exist and must be finite — an unbounded cap is the defect.
      expect(c.maxAttempts).toBeGreaterThan(0);
      expect(Number.isFinite(c.maxAttempts)).toBe(true);
      // Zero backoff is what let the storm run tight; this is the regression guard.
      expect(c.baseBackoffMs).toBeGreaterThan(0);
    });
  }

  it("keeps host-fault retries strictly tighter than transient-infra retries", () => {
    // A host fault repeating means the host or control plane is down; retrying harder
    // than a transient network blip would just reproduce the storm more slowly.
    const hostFault = classifyContinuationFailure(run("process_lost"));
    const transient = classifyContinuationFailure(run("adapter_failed"));
    expect(transient.kind).toBe("transient_infra");
    expect(hostFault.maxAttempts).toBeLessThan(transient.maxAttempts);
  });

  it("does not reclassify non-retryable or unknown codes", () => {
    // Guard against the host-fault set swallowing codes that must stay in their class.
    expect(classifyContinuationFailure(run("agent_not_invokable")).kind).toBe("non_retryable");
    expect(classifyContinuationFailure(run("some_unknown_code")).kind).toBe("default");
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
  });
});

// MAS-614 (Greptile finding #1 on PR #12946): `summarizeRecentContinuationRetries`'s
// `error_code` match mode pinned the *exact* error code, so a chain that alternated
// between codes in the same failure class (e.g. adapter_failed -> timeout ->
// adapter_failed) broke the streak on every change and never reached
// consecutive >= maxAttempts. That is the same "retry chains ran unbounded" defect
// MAS-93 was meant to close, just reopened for the realistic alternating-code case.
// The fix buckets by failure *class* (`error_class` match mode) instead of exact code.
describe("continuation retry streak: mixed error codes within one failure class", () => {
  it("classifies alternating transient_infra codes into the same class", () => {
    // adapter_failed and timeout are both TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.
    const a = classifyContinuationFailure(run("adapter_failed"));
    const t = classifyContinuationFailure(run("timeout"));
    expect(a.kind).toBe("transient_infra");
    expect(t.kind).toBe("transient_infra");
    expect(a.kind).toBe(t.kind);
  });

  it("classifies alternating host_fault codes into the same class", () => {
    const a = classifyContinuationFailure(run("process_lost"));
    const b = classifyContinuationFailure(run("acpx_turn_failed"));
    expect(a.kind).toBe("host_fault");
    expect(b.kind).toBe("host_fault");
  });

  it("a code from the other class is a different failure mode", () => {
    const transient = classifyContinuationFailure(run("adapter_failed"));
    const hostFault = classifyContinuationFailure(run("process_lost"));
    expect(transient.kind).not.toBe(hostFault.kind);
  });
});
