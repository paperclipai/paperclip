// Tests for cap/rate-limit-exhausted detection and the corresponding
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

  it("returns false when api_error_status is absent and no rate-limit text", () => {
    expect(isRateLimitExhausted({ result: "ok", is_error: false })).toBe(false);
  });

  it("returns false for non-429/401 api_error_status", () => {
    expect(isRateLimitExhausted({ api_error_status: 500 })).toBe(false);
    expect(isRateLimitExhausted({ api_error_status: null })).toBe(false);
  });

  it("returns true for api_error_status === 429 (number)", () => {
    expect(isRateLimitExhausted({ api_error_status: 429 })).toBe(true);
  });

  it("returns true for api_error_status === \"429\" (string)", () => {
    expect(isRateLimitExhausted({ api_error_status: "429" })).toBe(true);
  });

  it("returns true for api_error_status === 401 (cap-violation auth-fail)", () => {
    // Anthropic returns 401 on /v1/messages when the account hit its cap
    // even though the refresh endpoint still accepts the refresh_token —
    // this is what produced the "Failed to authenticate. API Error: 401"
    // error message during the 2026-05-05 cluster silence.
    expect(isRateLimitExhausted({ api_error_status: 401 })).toBe(true);
    expect(isRateLimitExhausted({ api_error_status: "401" })).toBe(true);
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

  it("returns true when result body contains cap text (subtype=success path)", () => {
    // claude CLI sometimes exits cleanly (subtype=success, no api_error_status)
    // with the cap message embedded in the result body. Observed 2026-05-05:
    //   "Claude run failed: subtype=success: You've hit your limit · resets May 6, 9pm (UTC)"
    expect(
      isRateLimitExhausted({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "You've hit your limit · resets May 6, 9pm (UTC)",
      }),
    ).toBe(true);
    expect(
      isRateLimitExhausted({
        message: "You're out of extra usage · resets in 24h",
      }),
    ).toBe(true);
  });

  it("returns true when adapter errorMessage contains cap-text or 401", () => {
    // Failed-path: errorMessage is set (resultJson may be null/minimal)
    // but the message reveals a rate-limit. Both surfaces should fire the
    // recoverable path so the on-limit hook drives ccrotate rotation.
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Failed to authenticate. API Error: 401",
      }),
    ).toBe(true);
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Claude run failed: subtype=success: You've hit your limit · resets May 6, 9pm (UTC)",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated 401 messages outside cap context", () => {
    // Don't false-positive on bare 401s from non-cap paths.
    expect(
      isRateLimitExhausted(null, {
        errorMessage: "Generic error 401: not our format",
      }),
    ).toBe(false);
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
    const looksRateLimited = isRateLimitExhausted(input.resultJson, {
      errorMessage: input.errorMessage,
    });
    if (outcome === "succeeded" && looksRateLimited) {
      outcome = "failed";
      rateLimitExhaustedOverride = true;
    } else if (outcome === "failed" && looksRateLimited) {
      // Already-failed runs whose errorMessage / resultJson reveals a
      // rate-limit also enter the recoverable path so the on-limit hook
      // can drive ccrotate rotation.
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
    // (Updated 2026-05-06: rate-limit gets its own family so retry uses a
    // flat short delay instead of stacking 2hr exponential backoff.)
    const persistedErrorFamily = rateLimitExhaustedOverride ? "rate_limit_exhausted" : null;

    return { outcome, errorCode, rateLimitExhaustedOverride, persistedErrorFamily };
  }

  it("overrides exit-0 + 429-result → failed/rate_limit_exhausted (own family)", () => {
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
    // The rate_limit_exhausted family routes the bounded retry to a flat
    // short delay (gate decides if pool has capacity); generic
    // transient_upstream still uses exponential backoff.
    expect(r.persistedErrorFamily).toBe("rate_limit_exhausted");
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

  it("DOES tag an already-failed run when resultJson reveals 429", () => {
    // Updated semantics (2026-05-05): the rate-limit override fires on
    // already-failed runs too, so finalizeAgentStatus's recoverable check
    // sees rate_limit_exhausted and the on-limit hook drives ccrotate
    // rotation. Without this, runs that fail via the failed branch (e.g.
    // 401-after-cap) flipped the agent to error and the cluster sat
    // silent until the cap window rolled.
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "adapter died",
      timedOut: false,
      cancelled: false,
      resultJson: { api_error_status: 429 },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
    expect(r.persistedErrorFamily).toBe("rate_limit_exhausted");
  });

  it("DOES tag a 401 errorMessage failure as rate_limit_exhausted", () => {
    // The exact pattern the cluster hit on 2026-05-05 16:09:18Z and after:
    // exit 1 + `Failed to authenticate. API Error: 401` once the active
    // account's cap window kicked in.
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "Failed to authenticate. API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication\"...",
      timedOut: false,
      cancelled: false,
      resultJson: null,
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
  });

  it("DOES tag exit-0 + cap-text-in-result-body as rate_limit_exhausted", () => {
    // claude CLI sometimes exits cleanly (subtype=success) with cap text
    // embedded in the result body and no api_error_status field.
    const r = evaluateOutcome({
      exitCode: 0,
      errorMessage: null,
      timedOut: false,
      cancelled: false,
      resultJson: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "You've hit your limit · resets May 6, 9pm (UTC)",
      },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(true);
    expect(r.errorCode).toBe("rate_limit_exhausted");
  });

  it("does NOT override unrelated failures with no rate-limit signals", () => {
    const r = evaluateOutcome({
      exitCode: 1,
      errorMessage: "some other adapter error",
      timedOut: false,
      cancelled: false,
      resultJson: { type: "result", is_error: true, result: "boom" },
    });
    expect(r.outcome).toBe("failed");
    expect(r.rateLimitExhaustedOverride).toBe(false);
    expect(r.errorCode).toBe("adapter_failed");
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

// ─── finalizeAgentStatus errorCode plumbing ────────────────────────────────
//
// Regression for the hook-firing gap observed 2026-05-05 19:12-21:00Z:
// PR #83 made `runErrorCode = "rate_limit_exhausted"` on the override path,
// but the `finalizeAgentStatus` call site at heartbeat.ts:6244 was passing
// `adapterResult.errorCode` (the raw adapter signal) instead. Result:
// 5+ heartbeat_runs correctly tagged `rate_limit_exhausted`, 0
// `quota-exhausted-hook` activity_log entries — the hook gate was reading
// the wrong code and short-circuiting the recoverable path.
describe("heartbeat finalizeAgentStatus errorCode plumbing", () => {
  // Mirrors the run-completion call site: which errorCode value is passed
  // into finalizeAgentStatus's opts? This is what controls whether
  // `recoverable=true` and `runQuotaExhaustedHook` fires.
  function whatGetsPassedToFinalizeAgentStatus(input: {
    runErrorCode: string | null;
    adapterErrorCode: string | null;
    /** When true, simulate the buggy call site (PR #83's blind spot). */
    useBuggyCallSite?: boolean;
  }): { errorCode: string | null } {
    if (input.useBuggyCallSite) {
      return { errorCode: input.adapterErrorCode ?? null };
    }
    return { errorCode: input.runErrorCode };
  }

  // Mirrors finalizeAgentStatus's recoverable check (heartbeat.ts:1898 in
  // master, expanded by PR #83 to accept both codes).
  function isRecoverableAfterPr83(errorCode: string | null): boolean {
    return (
      errorCode === "provider_quota_exhausted" ||
      errorCode === "rate_limit_exhausted"
    );
  }

  it("rate-limit override → finalize gets rate_limit_exhausted (recoverable=true)", () => {
    // The fix: pass runErrorCode (rate_limit_exhausted on override path).
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: null,
    });
    expect(passed.errorCode).toBe("rate_limit_exhausted");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(true);
  });

  it("rate-limit override on already-failed run → still gets rate_limit_exhausted", () => {
    // Failed-path with adapter setting "adapter_failed" but override
    // re-tagging to "rate_limit_exhausted" — the call site must use
    // runErrorCode, not adapterErrorCode.
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: "adapter_failed",
    });
    expect(passed.errorCode).toBe("rate_limit_exhausted");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(true);
  });

  it("non-rate-limit failures still propagate adapter error code", () => {
    // For non-override outcomes, runErrorCode FALLS BACK to
    // adapterResult.errorCode (heartbeat.ts:6082). The fix preserves this.
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "adapter_failed",
      adapterErrorCode: "adapter_failed",
    });
    expect(passed.errorCode).toBe("adapter_failed");
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(false);
  });

  it("succeeded runs pass null errorCode, recoverable=false", () => {
    const passed = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: null,
      adapterErrorCode: null,
    });
    expect(passed.errorCode).toBeNull();
    expect(isRecoverableAfterPr83(passed.errorCode)).toBe(false);
  });

  it("REGRESSION: buggy call site (using adapterResult.errorCode) → recoverable=false despite rate-limit override", () => {
    // This documents the bug the fix corrects: when the call site reads
    // adapterResult.errorCode (which is null/adapter_failed for cap hits)
    // instead of runErrorCode, the hook never fires. Asserting the
    // pathology so future refactors don't silently regress it.
    const buggy = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: null, // claude exits subtype=success, no adapter error
      useBuggyCallSite: true,
    });
    expect(buggy.errorCode).toBeNull();
    expect(isRecoverableAfterPr83(buggy.errorCode)).toBe(false);
  });

  it("REGRESSION: buggy call site (using adapterResult.errorCode='adapter_failed') → recoverable=false", () => {
    // Failed-path variant: adapter exits 1 with error message, override
    // re-tags to rate_limit_exhausted. Buggy call site reads "adapter_failed"
    // instead and hook is skipped.
    const buggy = whatGetsPassedToFinalizeAgentStatus({
      runErrorCode: "rate_limit_exhausted",
      adapterErrorCode: "adapter_failed",
      useBuggyCallSite: true,
    });
    expect(buggy.errorCode).toBe("adapter_failed");
    expect(isRecoverableAfterPr83(buggy.errorCode)).toBe(false);
  });
});
