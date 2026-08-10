import { describe, expect, it } from "vitest";
import {
  ConnectionCircuitBreaker,
  DatabaseUnavailableError,
  isConnectionFailure,
} from "./connection-circuit-breaker.js";

function connectionError(code: string): Error {
  return Object.assign(new Error(`write ${code} db:5432`), { code, errno: code });
}

/** A breaker on a clock the test controls, so no test waits out a timeout. */
function breakerAt(clock: { now: number }, failureThreshold = 3, resetTimeoutMs = 5_000) {
  return new ConnectionCircuitBreaker({ failureThreshold, resetTimeoutMs, now: () => clock.now });
}

describe("isConnectionFailure", () => {
  it("recognizes the postgres.js connection codes", () => {
    for (const code of [
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      "CONNECTION_DESTROYED",
      "CONNECTION_ENDED",
      "CONNECTION_REFUSED",
    ]) {
      expect(isConnectionFailure(connectionError(code))).toBe(true);
    }
  });

  it("recognizes the underlying socket codes", () => {
    expect(isConnectionFailure(connectionError("ECONNREFUSED"))).toBe(true);
    expect(isConnectionFailure(connectionError("ETIMEDOUT"))).toBe(true);
    expect(isConnectionFailure(connectionError("ENOTFOUND"))).toBe(true);
  });

  it("does not treat a server-side error as unreachable", () => {
    // A unique-violation means the server answered — it is up.
    expect(isConnectionFailure(connectionError("23505"))).toBe(false);
    expect(isConnectionFailure(new Error("syntax error at or near \"slect\""))).toBe(false);
    expect(isConnectionFailure(undefined)).toBe(false);
    expect(isConnectionFailure(null)).toBe(false);
    expect(isConnectionFailure("CONNECT_TIMEOUT")).toBe(false);
  });

  it("unwraps a wrapped connection failure", () => {
    const wrapped = new Error("query failed", { cause: connectionError("CONNECT_TIMEOUT") });
    expect(isConnectionFailure(wrapped)).toBe(true);
  });
});

describe("ConnectionCircuitBreaker", () => {
  it("stays closed while the database answers", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock);
    for (let i = 0; i < 10; i += 1) {
      expect(() => breaker.assertAvailable()).not.toThrow();
      breaker.recordSuccess();
    }
    expect(breaker.state).toBe("closed");
  });

  it("stays closed below the failure threshold", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 3);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    expect(breaker.state).toBe("closed");
    expect(() => breaker.assertAvailable()).not.toThrow();
  });

  it("opens on the nth consecutive connection failure and then fails fast", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 3, 5_000);
    for (let i = 0; i < 3; i += 1) breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    expect(breaker.state).toBe("open");
    expect(() => breaker.assertAvailable()).toThrow(DatabaseUnavailableError);
    expect(breaker.snapshot()).toEqual({ state: "open", consecutiveFailures: 3, retryAfterMs: 5_000 });

    // The whole point: rejection is immediate and repeatable, so handlers do
    // not accumulate waiting on a connection that is not coming.
    clock.now = 4_999;
    let thrown: unknown;
    try {
      breaker.assertAvailable();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DatabaseUnavailableError);
    expect((thrown as DatabaseUnavailableError).retryAfterMs).toBe(1);
    expect((thrown as DatabaseUnavailableError).code).toBe("DATABASE_CIRCUIT_OPEN");
  });

  it("resets the failure count when the server answers, even with an error", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 3);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("23505"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    expect(breaker.state).toBe("closed");
  });

  it("admits exactly one probe once the reset timeout elapses", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 2, 5_000);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    clock.now = 5_000;
    expect(breaker.state).toBe("halfOpen");
    expect(() => breaker.assertAvailable()).not.toThrow();
    // Second caller in the same window is still rejected.
    expect(() => breaker.assertAvailable()).toThrow(DatabaseUnavailableError);
  });

  it("closes when the probe succeeds", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 2, 5_000);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    clock.now = 5_000;
    breaker.assertAvailable();
    breaker.recordSuccess();

    expect(breaker.state).toBe("closed");
    expect(() => breaker.assertAvailable()).not.toThrow();
    expect(breaker.snapshot()).toEqual({ state: "closed", consecutiveFailures: 0, retryAfterMs: 0 });
  });

  it("restarts the cooldown when the probe fails", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 2, 5_000);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    clock.now = 5_000;
    breaker.assertAvailable();
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    expect(breaker.state).toBe("open");
    expect(breaker.snapshot().retryAfterMs).toBe(5_000);
    clock.now = 9_999;
    expect(() => breaker.assertAvailable()).toThrow(DatabaseUnavailableError);
    clock.now = 10_000;
    expect(() => breaker.assertAvailable()).not.toThrow();
  });

  it("releases a probe slot that was claimed but never settled", () => {
    const clock = { now: 0 };
    const breaker = breakerAt(clock, 2, 5_000);
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));
    breaker.recordFailure(connectionError("CONNECT_TIMEOUT"));

    clock.now = 5_000;
    breaker.assertAvailable(); // claimed, and the caller never reports back

    clock.now = 9_999;
    expect(() => breaker.assertAvailable()).toThrow(DatabaseUnavailableError);
    clock.now = 10_000;
    expect(() => breaker.assertAvailable()).not.toThrow();
  });

  it("rejects nonsensical settings instead of silently misbehaving", () => {
    expect(() => new ConnectionCircuitBreaker({ failureThreshold: 0 })).toThrow(/failureThreshold/);
    expect(() => new ConnectionCircuitBreaker({ failureThreshold: 1.5 })).toThrow(/failureThreshold/);
    expect(() => new ConnectionCircuitBreaker({ resetTimeoutMs: -1 })).toThrow(/resetTimeoutMs/);
  });
});
