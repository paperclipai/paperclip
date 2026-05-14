// Schedule-curve unit tests for rate-limit retries. The bounded transient
// retry table (2m / 10m / 30m / 2h) compounds for transient_upstream
// errors, but rate-limit "out of extra usage" failures already know the
// reset window and shouldn't stack a 2hr backoff. Verify the rate-limit
// schedule stays flat-and-short and the attempt cap is generous enough
// that a stuck pool fails loudly rather than silently after attempt 4.
import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS,
  computeRateLimitHeartbeatRetrySchedule,
} from "../services/heartbeat.js";

describe("computeRateLimitHeartbeatRetrySchedule", () => {
  const NOW = new Date("2026-05-06T03:00:00.000Z");

  it("returns null for non-positive attempts", () => {
    expect(computeRateLimitHeartbeatRetrySchedule(0, NOW, () => 0.5)).toBeNull();
    expect(computeRateLimitHeartbeatRetrySchedule(-1, NOW, () => 0.5)).toBeNull();
  });

  it("returns null for non-integer attempts", () => {
    expect(computeRateLimitHeartbeatRetrySchedule(1.5, NOW, () => 0.5)).toBeNull();
  });

  it("schedules attempt 1 at ~90s from now (with sample=0.5 → no jitter offset)", () => {
    const s = computeRateLimitHeartbeatRetrySchedule(1, NOW, () => 0.5);
    expect(s).not.toBeNull();
    expect(s!.attempt).toBe(1);
    expect(s!.baseDelayMs).toBe(RATE_LIMIT_HEARTBEAT_RETRY_DELAY_MS);
    // sample=0.5 → jitterMultiplier=1 → delayMs=90_000.
    expect(s!.delayMs).toBe(90_000);
    expect(s!.dueAt.getTime()).toBe(NOW.getTime() + 90_000);
  });

  it("does NOT stack the delay across attempts (each attempt gets the same flat ~90s)", () => {
    // The bug we're fixing: bounded transient retry stacked 2m → 10m → 30m
    // → 2h, pushing recovery 2hrs into the future after a few rate-limit
    // failures. The rate-limit schedule must NOT stack — each attempt
    // resolves to the same baseline ~90s.
    const a1 = computeRateLimitHeartbeatRetrySchedule(1, NOW, () => 0.5);
    const a3 = computeRateLimitHeartbeatRetrySchedule(3, NOW, () => 0.5);
    const a8 = computeRateLimitHeartbeatRetrySchedule(8, NOW, () => 0.5);
    expect(a1!.baseDelayMs).toBe(90_000);
    expect(a3!.baseDelayMs).toBe(90_000);
    expect(a8!.baseDelayMs).toBe(90_000);
    expect(a3!.delayMs).toBe(a1!.delayMs);
    expect(a8!.delayMs).toBe(a1!.delayMs);
  });

  it("applies ±25% jitter via the random sample", () => {
    const lo = computeRateLimitHeartbeatRetrySchedule(1, NOW, () => 0); // sample=0 → -25%
    const hi = computeRateLimitHeartbeatRetrySchedule(1, NOW, () => 1); // sample=1 → +25%
    expect(lo!.delayMs).toBe(Math.round(90_000 * 0.75)); // 67_500
    expect(hi!.delayMs).toBe(Math.round(90_000 * 1.25)); // 112_500
  });

  it("returns null past the per-family cap so retry-exhausted fires", () => {
    const s = computeRateLimitHeartbeatRetrySchedule(13, NOW, () => 0.5);
    // Cap is 12. A 13th attempt means we already retried 12 times after the
    // gate let the dispatch through; pool problems beyond that need
    // operator attention, not silent indefinite queuing.
    expect(s).toBeNull();
  });

  it("the cap is generous enough that a normal stuck pool resolves before exhausting", () => {
    // 12 attempts × ~90s = ~18 min of accumulated post-gate retries before
    // we give up. That's longer than any single 5h-cap rotation cycle and
    // covers normal pool-flap scenarios.
    const last = computeRateLimitHeartbeatRetrySchedule(12, NOW, () => 0.5);
    expect(last).not.toBeNull();
    expect(last!.maxAttempts).toBe(12);
  });
});
