import { describe, expect, it, vi } from "vitest";
import { createErrorThrottler, summarizeError } from "../lib/error-throttler.js";
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
});
