import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

// ZAL-355 Opción B: cap automatic `provider_quota` continuation retries to 2
// with exponential backoff (60s, 120s). Provider quota errors usually resolve
// only after the upstream quota resets, which the recovery wake honours via
// `providerQuotaRetryNotBefore`. A longer local ladder mostly spends budget.
//
// Keep `provider_quota` separate from the generic transient_infra set so the
// cap does not widen to legitimate upstream transients (claude_transient_upstream,
// codex_transient_upstream, timeout, etc.).
//
// Backoff math: with `baseBackoffMs = 60_000` and the existing
// `baseBackoffMs * 2^(consecutive-1)` multiplier, attempt 1 fires at 60s and
// attempt 2 at 120s. The recovery wake still waits for the upstream reset
// clock via `providerQuotaRetryNotBefore` / `parseProviderQuotaClockReset`,
// so the local ladder only governs the time between our own attempts.

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

describe("ZAL-355 Opción B — provider_quota retry classification", () => {
  it("classifies provider_quota with the new dedicated kind", () => {
    const c = classifyContinuationFailure(run("provider_quota"));
    expect(c.kind).toBe("provider_quota");
    expect(c.errorCode).toBe("provider_quota");
  });

  it("caps provider_quota to 2 continuation attempts (was 3 via TRANSIENT_INFRA)", () => {
    const c = classifyContinuationFailure(run("provider_quota"));
    expect(c.maxAttempts).toBe(2);
  });

  it("uses 60s base backoff so the existing exponential multiplier yields 60s, 120s", () => {
    const c = classifyContinuationFailure(run("provider_quota"));
    // baseBackoffMs * 2^(consecutive-1): consecutive=1 -> 60_000, consecutive=2 -> 120_000
    expect(c.baseBackoffMs).toBe(60_000);
    const attempt1Delay = c.baseBackoffMs * Math.pow(2, Math.max(0, 1 - 1));
    const attempt2Delay = c.baseBackoffMs * Math.pow(2, Math.max(0, 2 - 1));
    expect(attempt1Delay).toBe(60_000);
    expect(attempt2Delay).toBe(120_000);
  });

  it("removes provider_quota from the generic transient_infra path", () => {
    const c = classifyContinuationFailure(run("provider_quota"));
    expect(c.kind).not.toBe("transient_infra");
  });

  it.each([
    "claude_transient_upstream",
    "codex_transient_upstream",
    "codex_harness_crash",
    "adapter_failed",
    "timeout",
  ])("leaves legitimate upstream transients on TRANSIENT_INFRA (3 attempts): %s", (code) => {
    const c = classifyContinuationFailure(run(code));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBe(3);
  });

  it.each([
    "agent_not_invokable",
    "agent_not_found",
    "budget_blocked",
    "budget_exhausted",
    "issue_paused",
    "issue_dependencies_blocked",
  ])("does not regress non_retryable classification: %s", (code) => {
    const c = classifyContinuationFailure(run(code));
    expect(c.kind).toBe("non_retryable");
    expect(c.maxAttempts).toBe(0);
  });

  it("leaves unrelated error codes on the default branch", () => {
    const c = classifyContinuationFailure(run("cancelled"));
    expect(c.kind).toBe("default");
    expect(c.maxAttempts).toBe(1);
  });

  it("treats unknown / missing error codes as default", () => {
    expect(classifyContinuationFailure(run(null)).kind).toBe("default");
    expect(classifyContinuationFailure(run("some_adapter_error")).kind).toBe("default");
  });
});
