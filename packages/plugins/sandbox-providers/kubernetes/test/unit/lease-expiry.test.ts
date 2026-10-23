import { describe, it, expect } from "vitest";
import {
  computeBoundedLeaseDeadline,
  MIN_ACTIVE_DEADLINE_SEC,
  MAX_ACTIVE_DEADLINE_SEC,
} from "../../src/lease-expiry.js";

const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_SEC = NOW_MS / 1000;

describe("computeBoundedLeaseDeadline", () => {
  it("bounds the deadline to the caller's requested expiry, rounding down", () => {
    const requested = new Date(NOW_MS + 90_500).toISOString(); // 90.5s out
    const result = computeBoundedLeaseDeadline(requested, NOW_MS)!;
    // Rounds DOWN so the pod deadline never lands after the requested time.
    expect(result.activeDeadlineSec).toBe(90);
    expect(result.hardStopAtEpochSec).toBe(NOW_SEC + 90);
    expect(result.expiresAt).toBe(new Date(NOW_MS + 90_000).toISOString());
  });

  it("keeps the hard stop and expiresAt on whole seconds at or before the requested expiry", () => {
    const now = NOW_MS + 700; // sub-second clock
    const requested = new Date(now + 60_000).toISOString();
    const result = computeBoundedLeaseDeadline(requested, now)!;
    expect(Date.parse(result.expiresAt)).toBe(result.hardStopAtEpochSec * 1000);
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.parse(requested));
  });

  it("returns null (unbounded lease) when no deadline is requested", () => {
    expect(computeBoundedLeaseDeadline(null, NOW_MS)).toBeNull();
    expect(computeBoundedLeaseDeadline(undefined, NOW_MS)).toBeNull();
  });

  it("fails closed on an invalid requestedExpiresAt instead of silently falling back to a default", () => {
    expect(() => computeBoundedLeaseDeadline("not-a-date", NOW_MS)).toThrow(/valid/i);
  });

  it("fails closed (throws) when the requested deadline is already in the past", () => {
    const requested = new Date(NOW_MS - 5_000).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, NOW_MS)).toThrow(/already past or too close/);
  });

  it("fails closed when the requested deadline is exactly now", () => {
    const requested = new Date(NOW_MS).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, NOW_MS)).toThrow(/already past or too close/);
  });

  it("fails closed when the requested deadline is within MIN_ACTIVE_DEADLINE_SEC but not yet past", () => {
    const requested = new Date(NOW_MS + (MIN_ACTIVE_DEADLINE_SEC - 1) * 1000).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, NOW_MS)).toThrow(/already past or too close/);
  });

  it("accepts a deadline exactly at MIN_ACTIVE_DEADLINE_SEC", () => {
    const requested = new Date(NOW_MS + MIN_ACTIVE_DEADLINE_SEC * 1000).toISOString();
    const result = computeBoundedLeaseDeadline(requested, NOW_MS)!;
    expect(result.activeDeadlineSec).toBe(MIN_ACTIVE_DEADLINE_SEC);
  });

  it("does NOT silently clamp a past/imminent deadline up to a 1-second lease", () => {
    const requested = new Date(NOW_MS - 1).toISOString();
    expect(() => computeBoundedLeaseDeadline(requested, NOW_MS)).toThrow();
  });

  it("clamps a caller-requested deadline far in the future to MAX_ACTIVE_DEADLINE_SEC", () => {
    const farFuture = new Date(NOW_MS + (MAX_ACTIVE_DEADLINE_SEC + 1000) * 1000).toISOString();
    const result = computeBoundedLeaseDeadline(farFuture, NOW_MS)!;
    expect(result.activeDeadlineSec).toBe(MAX_ACTIVE_DEADLINE_SEC);
    expect(result.expiresAt).toBe(new Date(NOW_MS + MAX_ACTIVE_DEADLINE_SEC * 1000).toISOString());
  });
});
