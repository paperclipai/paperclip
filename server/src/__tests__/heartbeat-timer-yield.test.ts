import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_SKIP_TIMER_NON_TIMER_PENDING,
  HEARTBEAT_TIMER_NON_TIMER_PENDING_DEFER_SEC,
} from "../services/orchestration-invariants.js";
import { computeDeferredTimerBaseline } from "../services/heartbeat-timer-yield.js";

describe("heartbeat timer defer baseline (pure)", () => {
  it("exports stable HB-043 skip marker", () => {
    expect(HEARTBEAT_SKIP_TIMER_NON_TIMER_PENDING).toBe("heartbeat.timer_yield_non_timer_pending");
    expect(Number.isFinite(HEARTBEAT_TIMER_NON_TIMER_PENDING_DEFER_SEC)).toBe(true);
  });

  it("resets baseline to now when defer seconds is zero", () => {
    const nowMs = Date.parse("2026-05-17T12:00:00.000Z");
    const d = computeDeferredTimerBaseline(nowMs, 300, 0);
    expect(d.getTime()).toBe(nowMs);
  });

  it("defers next eligibility before the full interval expires", () => {
    const nowMs = Date.parse("2026-05-17T12:00:00.000Z");
    const d = computeDeferredTimerBaseline(nowMs, 300, 60);
    const elapsedIfNowWereTick = nowMs - d.getTime();
    expect(elapsedIfNowWereTick).toBe(240_000);
  });

  it("falls back to full-interval reset when defer >= interval", () => {
    const nowMs = Date.parse("2026-05-17T12:00:00.000Z");
    const d = computeDeferredTimerBaseline(nowMs, 120, 200);
    expect(d.getTime()).toBe(nowMs);
  });

  it("floors degenerate intervals to >= 1 second", () => {
    const nowMs = Date.parse("2026-05-17T12:00:00.000Z");
    const d = computeDeferredTimerBaseline(nowMs, 0.5, 1);
    const elapsedIfNowWereTick = nowMs - d.getTime();
    expect(elapsedIfNowWereTick).toBe(0);
  });
});
