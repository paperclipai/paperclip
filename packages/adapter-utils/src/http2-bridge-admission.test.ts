import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
  DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
  HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES,
  HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES,
  HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES,
  Http2BridgeAdmissionGate,
  MAX_HTTP2_BRIDGE_ADMISSION_CAP,
  configureHttp2BridgeAdmissionGate,
  getHttp2BridgeAdmissionGate,
  http2BridgeAdmissionBudgetBytes,
  isValidHttp2BridgeAdmissionCap,
  resolveHttp2BridgeAdmissionCaps,
  resolveMaxLiveHttp2BridgeSessions,
  resolveMaxParallelHttp2BridgeRequests,
} from "./http2-bridge-admission.js";

describe("Http2BridgeAdmissionGate — the stream gate", () => {
  it("admits up to the configured parallel cap and queues the rest", async () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 2, maxSessions: 8 });

    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(0);

    let thirdAdmitted = false;
    const thirdWaiter = gate.acquire().then((release) => {
      thirdAdmitted = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(1);
    void thirdWaiter;
  });

  it("releases slots to waiters in arrival order", async () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 1, maxSessions: 8 });
    const releaseFirst = await gate.acquire();

    const order: number[] = [];
    const p1 = gate.acquire().then((release) => {
      order.push(1);
      return release;
    });
    const p2 = gate.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = gate.acquire().then((release) => {
      order.push(3);
      return release;
    });

    releaseFirst();
    const release1 = await p1;
    expect(order).toEqual([1]);

    release1();
    const release2 = await p2;
    expect(order).toEqual([1, 2]);

    release2();
    const release3 = await p3;
    expect(order).toEqual([1, 2, 3]);

    release3();
  });

  it("a cancelled waiter leaves the queue and does not take a later slot", async () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 1, maxSessions: 8 });
    const releaseFirst = await gate.acquire();

    const controller = new AbortController();
    const cancelledWaiter = gate.acquire(controller.signal);
    const cancelledAssertion = expect(cancelledWaiter).rejects.toBeInstanceOf(Error);

    const secondWaiter = gate.acquire();
    expect(gate.queuedCount).toBe(2);

    controller.abort();
    await cancelledAssertion;
    expect(gate.queuedCount).toBe(1);

    releaseFirst();
    const releaseSecond = await secondWaiter;
    expect(typeof releaseSecond).toBe("function");
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(0);
    releaseSecond();
  });

  it("a second release call frees no second slot", async () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 1, maxSessions: 8 });
    const release = await gate.acquire();
    release();
    release();

    const releaseA = await gate.acquire();
    let secondAdmittedAtOnce = false;
    const pendingB = gate.acquire().then((releaseB) => {
      secondAdmittedAtOnce = true;
      return releaseB;
    });
    await Promise.resolve();

    // A double release must not free a second slot. If it had, both A and B
    // would admit at once instead of B waiting behind A in the queue.
    expect(secondAdmittedAtOnce).toBe(false);
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(1);

    releaseA();
    const releaseB = await pendingB;
    releaseB();
  });

  it("a release after every waiter left leaves the gate idle", async () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 1, maxSessions: 8 });
    const release = await gate.acquire();

    const controller = new AbortController();
    const waiter = gate.acquire(controller.signal);
    const rejection = expect(waiter).rejects.toBeInstanceOf(Error);
    controller.abort();
    await rejection;
    expect(gate.queuedCount).toBe(0);

    release();
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });
});

describe("Http2BridgeAdmissionGate — the session counter", () => {
  it("a session acquire past the cap returns null and never waits", () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 64, maxSessions: 1 });
    const release = gate.tryAcquireSession();
    expect(typeof release).toBe("function");

    const second = gate.tryAcquireSession();
    expect(second).toBeNull();
    expect(gate.activeSessionCount).toBe(1);
  });

  it("a released session slot goes to the next session acquire", () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 64, maxSessions: 1 });
    const release = gate.tryAcquireSession();
    expect(gate.tryAcquireSession()).toBeNull();

    release?.();
    expect(gate.activeSessionCount).toBe(0);

    const next = gate.tryAcquireSession();
    expect(typeof next).toBe("function");
    expect(gate.activeSessionCount).toBe(1);
  });

  it("a second session release call frees no second slot", () => {
    const gate = new Http2BridgeAdmissionGate({ maxParallel: 64, maxSessions: 1 });
    const release = gate.tryAcquireSession();
    release?.();
    release?.();
    expect(gate.activeSessionCount).toBe(0);

    const next = gate.tryAcquireSession();
    expect(typeof next).toBe("function");
    const overflow = gate.tryAcquireSession();
    expect(overflow).toBeNull();
  });
});

describe("isValidHttp2BridgeAdmissionCap", () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 65, "64", null, undefined, {}, []])(
    "rejects %p",
    (value) => {
      expect(isValidHttp2BridgeAdmissionCap(value)).toBe(false);
    },
  );

  it.each([1, 32, MAX_HTTP2_BRIDGE_ADMISSION_CAP])("accepts %p", (value) => {
    expect(isValidHttp2BridgeAdmissionCap(value)).toBe(true);
  });
});

describe("resolveMaxParallelHttp2BridgeRequests and resolveMaxLiveHttp2BridgeSessions", () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 65])(
    "rejects a zero, negative, non-integer, non-finite, or out-of-range override %p and returns the default",
    (value) => {
      const rejectedParallel: unknown[] = [];
      expect(
        resolveMaxParallelHttp2BridgeRequests(value, (rejected) => rejectedParallel.push(rejected)),
      ).toBe(DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS);
      expect(rejectedParallel).toEqual([value]);

      const rejectedSessions: unknown[] = [];
      expect(
        resolveMaxLiveHttp2BridgeSessions(value, (rejected) => rejectedSessions.push(rejected)),
      ).toBe(DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS);
      expect(rejectedSessions).toEqual([value]);
    },
  );

  it("uses the default for an absent or null override and reports nothing", () => {
    const rejected: unknown[] = [];
    expect(resolveMaxParallelHttp2BridgeRequests(undefined, (v) => rejected.push(v))).toBe(
      DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
    );
    expect(resolveMaxParallelHttp2BridgeRequests(null, (v) => rejected.push(v))).toBe(
      DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
    );
    expect(rejected).toEqual([]);
  });

  it("passes a valid override through unchanged and reports nothing", () => {
    const rejected: unknown[] = [];
    expect(resolveMaxParallelHttp2BridgeRequests(32, (v) => rejected.push(v))).toBe(32);
    expect(resolveMaxLiveHttp2BridgeSessions(4, (v) => rejected.push(v))).toBe(4);
    expect(rejected).toEqual([]);
  });
});

describe("the joint budget rule", () => {
  it("the default cap pair fits the reserved budget", () => {
    const total = http2BridgeAdmissionBudgetBytes(
      DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    );
    expect(total).toBe(189_792_192);
    expect(total).toBeLessThanOrEqual(HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES);
  });

  it("an over-budget pair of 64 parallel streams and 64 live sessions returns both defaults and reports a rejection", () => {
    const rejections: Array<{ maxParallel: number; maxSessions: number; totalBytes: number }> = [];
    const resolved = resolveHttp2BridgeAdmissionCaps(
      { maxParallel: 64, maxSessions: 64 },
      (rejection) => rejections.push(rejection),
    );

    expect(resolved).toEqual({
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ maxParallel: 64, maxSessions: 64, totalBytes: 1_129_316_288 });
    expect(rejections[0].totalBytes).toBeGreaterThan(HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES);
  });

  it("a valid over-default pair inside the reserved budget passes through unchanged", () => {
    const rejections: unknown[] = [];
    const resolved = resolveHttp2BridgeAdmissionCaps(
      { maxParallel: 1, maxSessions: 9 },
      (rejection) => rejections.push(rejection),
    );

    expect(resolved).toEqual({ maxParallel: 1, maxSessions: 9 });
    expect(rejections).toEqual([]);
    expect(http2BridgeAdmissionBudgetBytes(1, 9)).toBeLessThanOrEqual(HTTP2_BRIDGE_ADMISSION_RESERVED_BUDGET_BYTES);
  });

  it("a pair that fails the joint rule never keeps one override and gives both defaults", () => {
    // maxParallel=1 is a legal per-field override, but paired with maxSessions=64
    // the total still blows the reserved budget. The failed pair must not keep
    // the legal maxParallel override.
    const resolved = resolveHttp2BridgeAdmissionCaps({ maxParallel: 1, maxSessions: 64 });
    expect(resolved).toEqual({
      maxParallel: DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS,
      maxSessions: DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS,
    });
  });

  it("the joint rule computes the total from the byte constants, not from a stored value", () => {
    expect(http2BridgeAdmissionBudgetBytes(1, 0)).toBe(HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES);
    expect(http2BridgeAdmissionBudgetBytes(0, 1)).toBe(HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES);
    expect(http2BridgeAdmissionBudgetBytes(2, 3)).toBe(
      2 * HTTP2_BRIDGE_ADMITTED_STREAM_BUDGET_BYTES + 3 * HTTP2_BRIDGE_LIVE_SESSION_BUDGET_BYTES,
    );

    const first = http2BridgeAdmissionBudgetBytes(10, 1);
    const second = http2BridgeAdmissionBudgetBytes(20, 2);
    expect(second).toBe(2 * first);
  });
});

describe("the process-wide admission gate instance", () => {
  it("returns the same gate instance across calls until reconfigured", () => {
    const configured = configureHttp2BridgeAdmissionGate({ maxParallel: 2, maxSessions: 2 });
    expect(getHttp2BridgeAdmissionGate()).toBe(configured);
    expect(getHttp2BridgeAdmissionGate()).toBe(configured);
  });

  it("configureHttp2BridgeAdmissionGate replaces the instance and routes the pair through the joint resolver", () => {
    const previous = getHttp2BridgeAdmissionGate();
    const rejections: unknown[] = [];
    const next = configureHttp2BridgeAdmissionGate(
      { maxParallel: 64, maxSessions: 64 },
      (rejection) => rejections.push(rejection),
    );

    expect(next).not.toBe(previous);
    expect(next.maxParallel).toBe(DEFAULT_MAX_PARALLEL_HTTP2_BRIDGE_REQUESTS);
    expect(next.maxSessions).toBe(DEFAULT_MAX_LIVE_HTTP2_BRIDGE_SESSIONS);
    expect(rejections).toHaveLength(1);
    expect(getHttp2BridgeAdmissionGate()).toBe(next);
  });
});
