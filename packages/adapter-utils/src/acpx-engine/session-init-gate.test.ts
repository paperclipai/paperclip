import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_SESSION_INITS,
  DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS,
  SessionInitGate,
  resolveMaxConcurrentSessionInits,
  resolveSessionInitGateMaxWaitMs,
} from "./session-init-gate.js";

describe("resolveMaxConcurrentSessionInits", () => {
  it("defaults when the env var is absent or malformed", () => {
    expect(resolveMaxConcurrentSessionInits({})).toBe(DEFAULT_MAX_CONCURRENT_SESSION_INITS);
    expect(resolveMaxConcurrentSessionInits({ ACPX_MAX_CONCURRENT_SESSION_INITS: "banana" }))
      .toBe(DEFAULT_MAX_CONCURRENT_SESSION_INITS);
  });

  it("uses an explicit positive limit, flooring fractions", () => {
    expect(resolveMaxConcurrentSessionInits({ ACPX_MAX_CONCURRENT_SESSION_INITS: "2" })).toBe(2);
    expect(resolveMaxConcurrentSessionInits({ ACPX_MAX_CONCURRENT_SESSION_INITS: "3.7" })).toBe(3);
  });

  it("treats a non-positive value as disabling the gate", () => {
    expect(resolveMaxConcurrentSessionInits({ ACPX_MAX_CONCURRENT_SESSION_INITS: "0" }))
      .toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxConcurrentSessionInits({ ACPX_MAX_CONCURRENT_SESSION_INITS: "-1" }))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe("resolveSessionInitGateMaxWaitMs", () => {
  it("defaults when absent, malformed, or non-positive", () => {
    expect(resolveSessionInitGateMaxWaitMs({})).toBe(DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS);
    expect(resolveSessionInitGateMaxWaitMs({ ACPX_SESSION_INIT_GATE_MAX_WAIT_MS: "nope" }))
      .toBe(DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS);
    expect(resolveSessionInitGateMaxWaitMs({ ACPX_SESSION_INIT_GATE_MAX_WAIT_MS: "0" }))
      .toBe(DEFAULT_SESSION_INIT_GATE_MAX_WAIT_MS);
  });

  it("uses an explicit positive wait", () => {
    expect(resolveSessionInitGateMaxWaitMs({ ACPX_SESSION_INIT_GATE_MAX_WAIT_MS: "5000" })).toBe(5000);
  });
});

describe("SessionInitGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants immediately while under the limit", async () => {
    const gate = new SessionInitGate(() => 2, () => 60_000);

    const first = await gate.acquire();
    const second = await gate.acquire();

    expect(first.timedOut).toBe(false);
    expect(second.timedOut).toBe(false);
    expect(gate.activeCount).toBe(2);
    expect(gate.waitingCount).toBe(0);

    first.release();
    second.release();
    expect(gate.activeCount).toBe(0);
  });

  it("queues past the limit and grants in FIFO order on release", async () => {
    const gate = new SessionInitGate(() => 1, () => 60_000);

    const first = await gate.acquire();
    const order: string[] = [];
    const secondPromise = gate.acquire().then((slot) => {
      order.push("second");
      return slot;
    });
    const thirdPromise = gate.acquire().then((slot) => {
      order.push("third");
      return slot;
    });

    expect(gate.waitingCount).toBe(2);

    first.release();
    const second = await secondPromise;
    expect(order).toEqual(["second"]);
    expect(gate.activeCount).toBe(1);

    second.release();
    const third = await thirdPromise;
    expect(order).toEqual(["second", "third"]);

    third.release();
    expect(gate.activeCount).toBe(0);
    expect(gate.waitingCount).toBe(0);
  });

  it("fails open after the max wait without corrupting the active count", async () => {
    const gate = new SessionInitGate(() => 1, () => 1_000);

    const holder = await gate.acquire();
    const waiterPromise = gate.acquire();

    await vi.advanceTimersByTimeAsync(1_000);
    const waiter = await waiterPromise;

    expect(waiter.timedOut).toBe(true);
    expect(gate.waitingCount).toBe(0);
    // The ungated waiter never held a slot, so releasing it is a no-op.
    waiter.release();
    expect(gate.activeCount).toBe(1);

    holder.release();
    expect(gate.activeCount).toBe(0);
  });

  it("makes release idempotent", async () => {
    const gate = new SessionInitGate(() => 1, () => 60_000);

    const slot = await gate.acquire();
    slot.release();
    slot.release();
    expect(gate.activeCount).toBe(0);

    const again = await gate.acquire();
    expect(again.timedOut).toBe(false);
    again.release();
  });

  it("never gates when the limit resolves to Infinity", async () => {
    const gate = new SessionInitGate(() => Number.POSITIVE_INFINITY, () => 60_000);

    const slots = await Promise.all(
      Array.from({ length: 25 }, () => gate.acquire()),
    );
    expect(slots.every((slot) => !slot.timedOut && slot.waitedMs === 0)).toBe(true);
    expect(gate.waitingCount).toBe(0);
    for (const slot of slots) slot.release();
    expect(gate.activeCount).toBe(0);
  });
});
