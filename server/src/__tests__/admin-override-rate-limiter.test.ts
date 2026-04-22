import { describe, expect, it } from "vitest";
import {
  ADMIN_OVERRIDE_RATE_LIMITS,
  AdminOverrideRateLimiter,
} from "../admin-override-rate-limiter.js";

function createClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: () => t,
    advanceSeconds: (seconds: number) => {
      t += seconds * 1000;
    },
  };
}

describe("AdminOverrideRateLimiter", () => {
  it("allows up to 5 mints in the first hour (AC-8-B hourly limit)", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    for (let i = 0; i < 5; i += 1) {
      const decision = limiter.record("user-a");
      expect(decision.allowed).toBe(true);
      expect(decision.hourlyRemaining).toBe(4 - i);
    }
    const sixth = limiter.record("user-a");
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
    expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
  });

  it("6-in-1h test returns 429 on the 6th attempt (AC-8-B binding automated test)", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.record("user-a").allowed).toBe(true);
      clock.advanceSeconds(30);
    }
    const sixth = limiter.record("user-a");
    expect(sixth.allowed).toBe(false);
  });

  it("11-in-24h test returns 429 on the 11th attempt (AC-8-B binding automated test)", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.record("user-a").allowed).toBe(true);
      clock.advanceSeconds(60 * 75); // 1h15m between mints to dodge hourly limit
    }
    const eleventh = limiter.record("user-a");
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("allows 6th mint after the hourly window slides past the oldest record", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.record("user-a").allowed).toBe(true);
    }
    expect(limiter.record("user-a").allowed).toBe(false);
    clock.advanceSeconds(60 * 61);
    const allowed = limiter.record("user-a");
    expect(allowed.allowed).toBe(true);
  });

  it("isolates limits per principal", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.record("user-a").allowed).toBe(true);
    }
    expect(limiter.record("user-a").allowed).toBe(false);
    expect(limiter.record("user-b").allowed).toBe(true);
  });

  it("inspect() does not consume a slot", () => {
    const clock = createClock();
    const limiter = new AdminOverrideRateLimiter({ hourlyLimit: 5, dailyLimit: 10, nowMs: clock.now });
    limiter.record("user-a");
    const before = limiter.inspect("user-a");
    expect(before.hourlyRemaining).toBe(4);
    const again = limiter.inspect("user-a");
    expect(again.hourlyRemaining).toBe(4);
  });

  it("ships sensible defaults matching AC-8-B (5/hour, 10/day)", () => {
    expect(ADMIN_OVERRIDE_RATE_LIMITS).toEqual({ hourlyLimit: 5, dailyLimit: 10 });
  });
});
