import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, createErrorThrottler, summarizeError } from "../lib/error-throttler.js";
import type { Logger } from "pino";

function mockLogger(): Logger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe("summarizeError", () => {
  it("extracts error message from Error instance", () => {
    const err = new Error("Database connection failed");
    expect(summarizeError(err)).toEqual({ message: "Database connection failed", code: undefined });
  });

  it("extracts error code if present", () => {
    const err = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
    expect(summarizeError(err)).toEqual({ message: "Connection refused", code: "ECONNREFUSED" });
  });

  it("truncates long error messages exceeding maxLength", () => {
    const longMessage = "Failed query: " + "a".repeat(1000);
    const summary = summarizeError(new Error(longMessage), 100);
    expect(summary.message.length).toBeLessThanOrEqual(120);
    expect(summary.message).toContain("[truncated]");
  });

  it("handles non-Error objects and primitives gracefully", () => {
    expect(summarizeError("Plain text error")).toEqual({ message: "Plain text error", code: undefined });
    expect(summarizeError({ custom: "err" })).toEqual({ message: '{"custom":"err"}', code: undefined });
    expect(summarizeError(null)).toEqual({ message: "Unknown error", code: undefined });
    expect(summarizeError(undefined)).toEqual({ message: "Unknown error", code: undefined });
  });

  it("preserves falsy-but-defined thrown values instead of treating them as unknown", () => {
    // JS allows `throw 0` / `throw ""` / `throw false`; these are not "no error".
    expect(summarizeError(0)).toEqual({ message: "0", code: undefined });
    expect(summarizeError("")).toEqual({ message: "", code: undefined });
    expect(summarizeError(false)).toEqual({ message: "false", code: undefined });
  });
});

describe("ErrorThrottler", () => {
  it("logs the first error immediately", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock });
    const logger = mockLogger();

    const err = new Error("Postgres unreachable");
    throttler.logError(logger, "heartbeat timer tick failed", err);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith({ err }, "heartbeat timer tick failed");
  });

  it("suppresses repeated identical errors within minIntervalMs", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock });
    const logger = mockLogger();

    const err = new Error("Postgres unreachable");
    throttler.logError(logger, "heartbeat timer tick failed", err);
    expect(logger.error).toHaveBeenCalledTimes(1);

    // Call 2 & 3 within interval
    now += 1000;
    throttler.logError(logger, "heartbeat timer tick failed", err);
    now += 1000;
    throttler.logError(logger, "heartbeat timer tick failed", err);

    // Should still be called only once (suppressed 2 attempts)
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("logs summary with suppressed count after minIntervalMs passes", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock });
    const logger = mockLogger();

    const err = new Error("Postgres unreachable");
    throttler.logError(logger, "heartbeat timer tick failed", err);

    // 3 suppressed calls
    now += 1000;
    throttler.logError(logger, "heartbeat timer tick failed", err);
    now += 1000;
    throttler.logError(logger, "heartbeat timer tick failed", err);
    now += 1000;
    throttler.logError(logger, "heartbeat timer tick failed", err);

    // Now advance past 5000ms
    now += 3000;
    throttler.logError(logger, "heartbeat timer tick failed", err);

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenLastCalledWith(
      { err, suppressedErrors: 3 },
      "[suppressed 3 repeated errors] heartbeat timer tick failed",
    );
  });

  it("logs distinct errors independently", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock });
    const logger = mockLogger();

    const err1 = new Error("Database down");
    const err2 = new Error("Network timeout");

    throttler.logError(logger, "heartbeat timer tick failed", err1);
    throttler.logError(logger, "routine scheduler tick failed", err2);

    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("resets suppression state when reset() is called", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock });
    const logger = mockLogger();

    const err = new Error("Database down");
    throttler.logError(logger, "heartbeat timer tick failed", err);
    expect(logger.error).toHaveBeenCalledTimes(1);

    throttler.reset();

    // After reset, same error logs immediately again
    now += 500;
    throttler.logError(logger, "heartbeat timer tick failed", err);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("bounds tracked state so distinct-message errors cannot grow memory unboundedly", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock, maxTrackedKeys: 3 });
    const logger = mockLogger();

    // Each error carries a unique piece of detail (e.g. a row id or query
    // param), producing a distinct throttle key every time.
    for (let i = 0; i < 100; i++) {
      throttler.logError(logger, "sweep failed", new Error(`row ${i} failed`));
      now += 1;
    }

    // Internal state must not grow past the configured cap.
    expect((throttler as unknown as { state: Map<string, unknown> }).state.size).toBeLessThanOrEqual(3);

    // Every call was for a first-seen key, so every call should have logged
    // immediately regardless of eviction.
    expect(logger.error).toHaveBeenCalledTimes(100);
  });

  it("evicts the least-recently-active key first, not an arbitrarily chosen one", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5000, clock, maxTrackedKeys: 2 });
    const logger = mockLogger();

    throttler.logError(logger, "ctx", new Error("a")); // call 1: first-seen "a"
    now += 1;
    throttler.logError(logger, "ctx", new Error("b")); // call 2: first-seen "b"
    now += 1;
    // Re-touch "a" so "b" becomes the least-recently-active key.
    now += 6000; // past minIntervalMs so this counts as a fresh log for "a"
    throttler.logError(logger, "ctx", new Error("a")); // call 3: "a" refreshed
    now += 1;
    // Adding a third distinct key should evict "b" (least-recently-active), not "a".
    throttler.logError(logger, "ctx", new Error("c")); // call 4: first-seen "c"
    expect(logger.error).toHaveBeenCalledTimes(4);

    // "a" was refreshed most recently among the original two, so logging it
    // again immediately should still be suppressed (not evicted) - no new call.
    now += 1;
    throttler.logError(logger, "ctx", new Error("a"));
    expect(logger.error).toHaveBeenCalledTimes(4);

    // "b" was evicted, so logging it again is treated as first-seen again.
    now += 1;
    throttler.logError(logger, "ctx", new Error("b"));
    expect(logger.error).toHaveBeenCalledTimes(5);
  });
});

describe("computeBackoffDelayMs", () => {
  const baseIntervalMs = 30_000;
  const maxIntervalMs = 300_000;

  it("returns the base interval with no consecutive failures", () => {
    expect(computeBackoffDelayMs(0, { baseIntervalMs, maxIntervalMs })).toBe(30_000);
  });

  it("doubles per consecutive failure up to the step cap", () => {
    expect(computeBackoffDelayMs(1, { baseIntervalMs, maxIntervalMs })).toBe(60_000);
    expect(computeBackoffDelayMs(2, { baseIntervalMs, maxIntervalMs })).toBe(120_000);
    expect(computeBackoffDelayMs(3, { baseIntervalMs, maxIntervalMs })).toBe(240_000);
  });

  it("caps the delay at maxIntervalMs once the step cap is reached", () => {
    expect(computeBackoffDelayMs(4, { baseIntervalMs, maxIntervalMs })).toBe(300_000);
    expect(computeBackoffDelayMs(10, { baseIntervalMs, maxIntervalMs })).toBe(300_000);
  });

  it("treats negative failure counts as zero (no negative backoff)", () => {
    expect(computeBackoffDelayMs(-5, { baseIntervalMs, maxIntervalMs })).toBe(30_000);
  });

  it("honors a custom maxBackoffSteps", () => {
    expect(computeBackoffDelayMs(1, { baseIntervalMs, maxIntervalMs, maxBackoffSteps: 0 })).toBe(30_000);
    expect(computeBackoffDelayMs(2, { baseIntervalMs, maxIntervalMs, maxBackoffSteps: 1 })).toBe(60_000);
  });
});
