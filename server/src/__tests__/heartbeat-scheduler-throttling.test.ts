import { describe, expect, it, vi } from "vitest";
import { computeBackoffDelayMs, createErrorThrottler } from "../lib/error-throttler.js";
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
    // Uses the same computeBackoffDelayMs helper that server/src/index.ts's
    // heartbeat scheduler calls, so this test breaks if the production
    // formula ever changes, instead of silently drifting from reality.
    const baseMs = 30_000;
    const maxMs = 300_000;
    const calculateBackoff = (failures: number) =>
      computeBackoffDelayMs(failures, { baseIntervalMs: baseMs, maxIntervalMs: maxMs });

    expect(calculateBackoff(0)).toBe(30_000);   // Normal interval
    expect(calculateBackoff(1)).toBe(60_000);   // 1 failure -> 1 min
    expect(calculateBackoff(2)).toBe(120_000);  // 2 failures -> 2 mins
    expect(calculateBackoff(3)).toBe(240_000);  // 3 failures -> 4 mins
    expect(calculateBackoff(4)).toBe(300_000);  // 4 failures -> capped at 5 mins
    expect(calculateBackoff(10)).toBe(300_000); // 10 failures -> capped at 5 mins
  });

  it("simulates a full outage/recovery cycle: backoff grows, then resets once ticks succeed again", () => {
    // Mirrors server/src/index.ts's startHeartbeatSchedulerInterval loop:
    // each failed tick increments a failure counter that feeds
    // computeBackoffDelayMs; a single successful tick resets both the
    // counter and the error throttler's suppression state.
    const baseMs = 30_000;
    const maxMs = 300_000;
    let now = 0;
    const clock = () => now;
    // Larger than the cumulative elapsed time across the whole 5-tick outage
    // below (450s), so every repeated failure during the outage is suppressed.
    const throttler = createErrorThrottler({ minIntervalMs: 10 * 60 * 1000, clock });
    const logger = { error: vi.fn() } as unknown as Logger;

    let consecutiveFailures = 0;
    const delays: number[] = [];
    const dbError = new Error("could not open shared memory segment");

    const runTick = (succeeds: boolean) => {
      delays.push(computeBackoffDelayMs(consecutiveFailures, { baseIntervalMs: baseMs, maxIntervalMs: maxMs }));
      if (succeeds) {
        if (consecutiveFailures > 0) {
          consecutiveFailures = 0;
          throttler.reset();
        }
      } else {
        consecutiveFailures += 1;
        throttler.logError(logger, "heartbeat scheduler tick failed", dbError);
      }
      now += delays[delays.length - 1];
    };

    // Outage: five consecutive failing ticks.
    for (let i = 0; i < 5; i++) runTick(false);
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(consecutiveFailures).toBe(5);
    // Repeated identical errors during the outage were throttled, not spammed.
    expect(logger.error).toHaveBeenCalledTimes(1);

    // Recovery: the next tick succeeds.
    runTick(true);
    expect(consecutiveFailures).toBe(0);

    // Backoff is back to the base interval immediately after recovery.
    const postRecoveryDelay = computeBackoffDelayMs(consecutiveFailures, { baseIntervalMs: baseMs, maxIntervalMs: maxMs });
    expect(postRecoveryDelay).toBe(30_000);

    // And the throttler's suppression state was cleared too: a subsequent
    // failure with the *same* error logs immediately again instead of being
    // treated as a continuation of the old suppressed streak.
    throttler.logError(logger, "heartbeat scheduler tick failed", dbError);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
