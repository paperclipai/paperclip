import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

function fixedClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("CircuitBreaker", () => {
  it("stays closed and admits requests below the failure threshold", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: () => 0 });
    expect(b.tryAcquire("figma")).toBe(true);
    b.recordFailure("figma");
    b.recordFailure("figma");
    expect(b.stateOf("figma")).toBe("closed");
    expect(b.tryAcquire("figma")).toBe(true);
  });

  it("opens after N consecutive failures and then fast-fails", () => {
    const clock = fixedClock();
    const b = new CircuitBreaker({ failureThreshold: 3, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: clock.now });
    for (let i = 0; i < 3; i += 1) {
      expect(b.tryAcquire("figma")).toBe(true);
      b.recordFailure("figma");
    }
    expect(b.stateOf("figma")).toBe("open");
    // Fast-fail while open, before the cooldown elapses.
    expect(b.tryAcquire("figma")).toBe(false);
  });

  it("resets the consecutive-failure count on any success", () => {
    const b = new CircuitBreaker({ failureThreshold: 3, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: () => 0 });
    b.tryAcquire("figma"); b.recordFailure("figma");
    b.tryAcquire("figma"); b.recordFailure("figma");
    b.tryAcquire("figma"); b.recordSuccess("figma"); // resets the streak
    b.tryAcquire("figma"); b.recordFailure("figma");
    b.tryAcquire("figma"); b.recordFailure("figma");
    expect(b.stateOf("figma")).toBe("closed");
  });

  it("admits a single half-open probe after the cooldown and closes on probe success", () => {
    const clock = fixedClock();
    const b = new CircuitBreaker({ failureThreshold: 2, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: clock.now });
    b.tryAcquire("figma"); b.recordFailure("figma");
    b.tryAcquire("figma"); b.recordFailure("figma");
    expect(b.stateOf("figma")).toBe("open");
    // Before cooldown: still fast-fail.
    clock.advance(999);
    expect(b.tryAcquire("figma")).toBe(false);
    // After cooldown: exactly one probe admitted, a concurrent second blocked.
    clock.advance(1);
    expect(b.tryAcquire("figma")).toBe(true);
    expect(b.stateOf("figma")).toBe("half-open");
    expect(b.tryAcquire("figma")).toBe(false);
    // Probe succeeds → closed, admits normally again.
    b.recordSuccess("figma");
    expect(b.stateOf("figma")).toBe("closed");
    expect(b.tryAcquire("figma")).toBe(true);
  });

  it("reopens for another cooldown when the half-open probe fails", () => {
    const clock = fixedClock();
    const b = new CircuitBreaker({ failureThreshold: 1, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: clock.now });
    b.tryAcquire("figma"); b.recordFailure("figma");
    expect(b.stateOf("figma")).toBe("open");
    clock.advance(1000);
    expect(b.tryAcquire("figma")).toBe(true); // half-open probe
    b.recordFailure("figma"); // probe fails
    expect(b.stateOf("figma")).toBe("open");
    expect(b.tryAcquire("figma")).toBe(false); // fast-fail again, cooldown reset
    clock.advance(1000);
    expect(b.tryAcquire("figma")).toBe(true); // new probe after the new cooldown
  });

  it("isolates state per prefix", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: () => 0 });
    b.tryAcquire("figma"); b.recordFailure("figma");
    expect(b.stateOf("figma")).toBe("open");
    expect(b.stateOf("linear")).toBe("closed");
    expect(b.tryAcquire("linear")).toBe(true);
  });

  it("snapshot reports per-prefix state for /healthz", () => {
    const b = new CircuitBreaker({ failureThreshold: 1, openCooldownMs: 1000, halfOpenMaxProbes: 1, now: () => 0 });
    b.tryAcquire("figma"); b.recordFailure("figma");
    b.tryAcquire("linear"); b.recordSuccess("linear");
    expect(b.snapshot()).toEqual({ figma: "open", linear: "closed" });
  });
});
