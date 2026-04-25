import { describe, expect, it } from "vitest";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS,
  computeBoundedTransientHeartbeatRetrySchedule,
} from "../services/heartbeat.ts";

// PMSA-18 / PMSA-11 §3.3: pure-function coverage for the schedule primitive
// that scheduleBoundedRetryForRun consumes. Lives outside the integration
// suite so it runs even on hosts without embedded Postgres.
describe("computeBoundedTransientHeartbeatRetrySchedule (quota)", () => {
  const now = new Date("2026-04-21T08:00:00.000Z");

  it("uses the quota schedule (60s/240s/900s) when passed quota delays", () => {
    const expected = [60_000, 240_000, 900_000];

    expect(BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS).toEqual(expected);

    for (let i = 0; i < expected.length; i += 1) {
      const schedule = computeBoundedTransientHeartbeatRetrySchedule(
        i + 1,
        now,
        () => 0.5, // disable jitter
        BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS,
      );
      expect(schedule).not.toBeNull();
      if (!schedule) continue;
      expect(schedule.attempt).toBe(i + 1);
      expect(schedule.maxAttempts).toBe(expected.length);
      expect(schedule.baseDelayMs).toBe(expected[i]);
      expect(schedule.delayMs).toBe(expected[i]);
      expect(schedule.dueAt.getTime() - now.getTime()).toBe(expected[i]);
    }
  });

  it("returns null past the quota cap so callers fall through to exhausted", () => {
    expect(
      computeBoundedTransientHeartbeatRetrySchedule(
        BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS.length + 1,
        now,
        () => 0.5,
        BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS,
      ),
    ).toBeNull();
  });

  it("preserves the legacy 4-step generic schedule when no delays arg is passed", () => {
    const expected = BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS;
    const schedule = computeBoundedTransientHeartbeatRetrySchedule(
      1,
      now,
      () => 0.5,
    );
    expect(schedule).not.toBeNull();
    if (!schedule) return;
    expect(schedule.maxAttempts).toBe(expected.length);
    expect(schedule.baseDelayMs).toBe(expected[0]);
  });

  it("rejects non-positive attempt numbers", () => {
    expect(
      computeBoundedTransientHeartbeatRetrySchedule(
        0,
        now,
        () => 0.5,
        BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS,
      ),
    ).toBeNull();
    expect(
      computeBoundedTransientHeartbeatRetrySchedule(
        -1,
        now,
        () => 0.5,
        BOUNDED_TRANSIENT_QUOTA_RETRY_DELAYS_MS,
      ),
    ).toBeNull();
  });
});
