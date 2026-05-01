// Tests for 429 rate-limit-exhausted detection and the corresponding
// outcome override that routes the run into the bounded transient retry.
import { describe, expect, it } from "vitest";
import { isRateLimitExhausted } from "../services/heartbeat.js";

describe("isRateLimitExhausted", () => {
  it("returns false for null", () => {
    expect(isRateLimitExhausted(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isRateLimitExhausted(undefined)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isRateLimitExhausted({})).toBe(false);
  });

  it("returns false when api_error_status is absent", () => {
    expect(isRateLimitExhausted({ result: "ok", is_error: false })).toBe(false);
  });

  it("returns false for non-429 api_error_status", () => {
    expect(isRateLimitExhausted({ api_error_status: 500 })).toBe(false);
    expect(isRateLimitExhausted({ api_error_status: 401 })).toBe(false);
    expect(isRateLimitExhausted({ api_error_status: null })).toBe(false);
  });

  it("returns true for api_error_status === 429 (number)", () => {
    expect(isRateLimitExhausted({ api_error_status: 429 })).toBe(true);
  });

  it("returns true for api_error_status === \"429\" (string)", () => {
    expect(isRateLimitExhausted({ api_error_status: "429" })).toBe(true);
  });

  it("returns true on the real-world 429 result shape", () => {
    expect(
      isRateLimitExhausted({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "You're out of extra usage · resets May 2, 1pm (UTC)",
        stop_reason: "stop_sequence",
      }),
    ).toBe(true);
  });
});

describe("heartbeat outcome — rate-limit-exhausted integration", () => {
  // Mirrors heartbeat-empty-result.test.ts: replicates the inline outcome
  // composition + override + downstream errorCode/errorFamily resolution
  // without standing up the full DB/adapter mock harness.

  function evaluateOutcome(input: {
    exitCode: number | null;
    errorMessage: string | null;
    timedOut: boolean;
    cancelled: boolean;
    resultJson: Record<string, unknown> | null | undefined;
  }): {
    outcome: string;
    errorCode: string | null;
    rateLimitExhaustedOverride: boolean;
    persistedErrorFamily: string | null;
  } {
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

    let rateLimitExhaustedOverride = false;
    if (outcome === "succeeded" && isRateLimitExhausted(input.resultJson)) {
      outcome = "failed";
      rateLimitExhaustedOverride = true;
    }

    const errorCode = rateLimitExhaustedOverride
      ? "rate_limit_exhausted"
      : outcome === "timed_out"
        ? "timeout"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "failed"
            ? "adapter_failed"
            : null;

    // Persisted errorFamily mirrors the inline override in the merge path.
    const persistedErrorFamily = rateLimitExhaustedOverride ? "transient_upstream" : null;

    return { outcome, errorCode, rateLimitExhaustedOverride, persistedErrorFamily };
  }

  it("overrides exit-0 + 429-result → failed/rate_limit_exhausted/transient_upstream", () => {
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: {
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "You're out of extra usage · resets May 2, 1pm (UTC)",
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.errorCode).toBe("rate_limit_exhausted");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    // The transient_upstream contract is what gates the bounded retry path.
    expect(r.persistedErrorFamily).toBe("transient_upstream");
  });

  it("does NOT override exit-0 + non-429-result", () => {
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: { type: "result", is_error: false, result: "Done" },
    });
    expect(r.outcome).toBe("succeeded");
    expect(r.errorCode).toBeNull();
    expect(r.rateLimitExhaustedOverride).toBe(false);
    expect(r.persistedErrorFamily).toBeNull();
  });

  it("does NOT override an already-failed run that happens to carry a 429 result", () => {
    // If the adapter already failed (non-zero exit), the rate-limit override
    // shouldn't fire — the run is already on the failed path with whatever
    // adapter-specific error code applies.
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "adapter died",
      timedOut: false,
      cancelled: false,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(false);
    expect(r.errorCode).toBe("adapter_failed");
    expect(r.persistedErrorFamily).toBeNull();
  });

  it("does NOT override timed-out runs", () => {
    const r = evaluateOutcome({
      exitCode: null,
      errorMessage: null,
      timedOut: true,
      cancelled: false,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("timed_out");
    expect(r.errorCode).toBe("timeout");
    expect(r.rateLimitExhaustedOverride).toBe(false);
  });

  it("does NOT override cancelled runs", () => {
    const r = evaluateOutcome({
      exitCode: null,
      errorMessage: null,
      timedOut: false,
      cancelled: true,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("cancelled");
    expect(r.errorCode).toBe("cancelled");
    expect(r.rateLimitExhaustedOverride).toBe(false);
  });
});
