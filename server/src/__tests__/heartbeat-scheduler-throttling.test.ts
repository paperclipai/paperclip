import { describe, expect, it, vi } from "vitest";
import { createErrorThrottler } from "../lib/error-throttler.js";
import type { Logger } from "pino";

describe("heartbeat scheduler throttling & backoff", () => {
  it("prevents log flooding when background tasks fail repeatedly", () => {
    let now = 1000;
    const clock = () => now;
    const throttler = createErrorThrottler({ minIntervalMs: 5 * 60 * 1000, clock });

    const logger = {
      error: vi.fn(),
    } as unknown as Logger;

    const dbError = new Error('Failed query: select "routine_triggers"."id" ... could not open shared memory segment');

    // Simulate 1000 failing ticks over 130 seconds (like issue 10911)
    for (let i = 0; i < 1000; i++) {
      throttler.logError(logger, "heartbeat timer tick failed", dbError);
      throttler.logError(logger, "routine scheduler tick failed", dbError);
      throttler.logError(logger, "heartbeat scheduler tick failed", dbError);
      now += 130;
    }

    // Instead of 3000 log calls, only the initial 3 log calls should have occurred
    expect(logger.error).toHaveBeenCalledTimes(3);

    // Fast-forward past 5 minutes (300,000 ms)
    now += 300_000;

    throttler.logError(logger, "heartbeat timer tick failed", dbError);

    // Should log a summary of suppressed error count
    expect(logger.error).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ suppressedErrors: 999 }),
      expect.stringContaining("[suppressed 999 repeated errors] heartbeat timer tick failed"),
    );
  });

  it("calculates exponential backoff correctly for consecutive failures", () => {
    const baseMs = 30_000;
    const maxMs = 300_000;

    const calculateBackoff = (failures: number) => {
      const backoffFactor = Math.pow(2, Math.min(failures, 4));
      return Math.min(maxMs, baseMs * backoffFactor);
    };

    expect(calculateBackoff(0)).toBe(30_000);   // Normal interval
    expect(calculateBackoff(1)).toBe(60_000);   // 1 failure -> 1 min
    expect(calculateBackoff(2)).toBe(120_000);  // 2 failures -> 2 mins
    expect(calculateBackoff(3)).toBe(240_000);  // 3 failures -> 4 mins
    expect(calculateBackoff(4)).toBe(300_000);  // 4 failures -> capped at 5 mins
    expect(calculateBackoff(10)).toBe(300_000); // 10 failures -> capped at 5 mins
  });
});
