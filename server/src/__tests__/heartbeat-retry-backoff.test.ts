import { describe, expect, it } from "vitest";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  computeBoundedTransientHeartbeatRetrySchedule,
} from "../services/heartbeat.ts";

// The bounded transient retry is the automatic recovery path used when a
// dependency is temporarily unavailable. The scheduled wait must GROW between
// attempts. Before this test the delays were flat ([30_000, 30_000]), so two
// attempts burned the whole budget at the same distance.
describe("bounded transient heartbeat retry backoff", () => {
  it("grows the scheduled delay with each attempt instead of staying flat", () => {
    const delays = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS;
    expect(delays.length).toBeGreaterThanOrEqual(2);
    for (let attempt = 1; attempt < delays.length; attempt += 1) {
      expect(delays[attempt]).toBeGreaterThan(delays[attempt - 1]);
    }
  });

  it("schedules the growing delay for each attempt", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const first = computeBoundedTransientHeartbeatRetrySchedule(1, now, () => 0);
    const second = computeBoundedTransientHeartbeatRetrySchedule(2, now, () => 0);
    if (!first || !second) {
      throw new Error("expected schedules for attempts 1 and 2");
    }
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
    expect(second.maxAttempts).toBe(
      BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    );
  });
});
