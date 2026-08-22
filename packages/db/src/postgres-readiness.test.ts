import { describe, expect, it, vi } from "vitest";
import {
  isPostgresConnectionUnavailableError,
  isPostgresNotReadyError,
  isPostgresStartingUpError,
  waitForPostgresReady,
} from "./client.js";

/** How postgres.js surfaces a server error: fields assigned onto the Error. */
function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: "FATAL" });
}

function connectionError(code: string): Error {
  return Object.assign(new Error(`connect ${code} 127.0.0.1:54329`), { code });
}

/** Drizzle wraps driver failures, so the real code is only on `cause`. */
function wrapped(cause: Error): Error {
  return Object.assign(new Error(`Failed query: select 1: ${cause.message}`), { cause });
}

const STARTING_UP = () => postgresError("57P03", "the database system is starting up");

describe("postgres readiness error classification", () => {
  it("recognizes 57P03 as starting up", () => {
    expect(isPostgresStartingUpError(STARTING_UP())).toBe(true);
    expect(isPostgresNotReadyError(STARTING_UP())).toBe(true);
  });

  it("recognizes 57P03 through a wrapped cause chain", () => {
    expect(isPostgresStartingUpError(wrapped(STARTING_UP()))).toBe(true);
  });

  it("recognizes connection failures that mean nothing is listening yet", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "CONNECTION_CLOSED"]) {
      expect(isPostgresConnectionUnavailableError(connectionError(code))).toBe(true);
    }
    expect(isPostgresConnectionUnavailableError(wrapped(connectionError("ECONNREFUSED")))).toBe(true);
  });

  it("treats the connect-timeout code postgres.js actually emits as transient", () => {
    // Guard against inventing a constant. postgres.js raises this verbatim from
    // Errors.connection("CONNECT_TIMEOUT") when the socket opens but the startup
    // handshake does not finish in time, which is routine while a postmaster
    // replays WAL. The list previously held "CONNECTION_CONNECT_TIMEOUT", which
    // postgres.js never emits, so real connect timeouts were treated as fatal.
    // Asserting against the library spelling is what catches that; asserting
    // against our own exported list would simply confirm the typo.
    expect(isPostgresConnectionUnavailableError(connectionError("CONNECT_TIMEOUT"))).toBe(true);
    expect(isPostgresNotReadyError(connectionError("CONNECT_TIMEOUT"))).toBe(true);
    expect(isPostgresNotReadyError(connectionError("CONNECTION_CONNECT_TIMEOUT"))).toBe(false);
  });

  it("does not treat authentication or shutdown failures as transient", () => {
    // 28P01 is a bad password and 57P01 is an admin shutdown; retrying either
    // until the deadline would just hide the real failure.
    expect(isPostgresNotReadyError(postgresError("28P01", "password authentication failed"))).toBe(false);
    expect(isPostgresNotReadyError(postgresError("57P01", "terminating connection due to administrator command"))).toBe(false);
    expect(isPostgresNotReadyError(new Error("connect ECONNREFUSED mentioned in prose"))).toBe(false);
  });
});

describe("waitForPostgresReady", () => {
  const url = "postgres://paperclip:paperclip@127.0.0.1:54329/postgres";

  it("returns as soon as the probe succeeds", async () => {
    const probe = vi.fn(async () => {});
    await waitForPostgresReady(url, { probe, sleep: async () => {} });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries through WAL recovery instead of failing on the first 57P03", async () => {
    // The bug: adopting a cluster mid-recovery threw 57P03 straight out of the
    // first ensurePostgresDatabase call and killed the server. It only ever
    // came up because `tsx watch` happened to restart after recovery finished.
    let attempts = 0;
    const probe = vi.fn(async () => {
      attempts += 1;
      if (attempts < 4) throw STARTING_UP();
    });

    await waitForPostgresReady(url, { probe, sleep: async () => {} });
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("retries while the socket is still refusing connections", async () => {
    let attempts = 0;
    const probe = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw wrapped(connectionError("ECONNREFUSED"));
    });

    await waitForPostgresReady(url, { probe, sleep: async () => {} });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("backs off between attempts up to the cap", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const probe = async () => {
      attempts += 1;
      if (attempts < 6) throw STARTING_UP();
    };

    await waitForPostgresReady(url, {
      probe,
      initialDelayMs: 100,
      maxDelayMs: 300,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays).toEqual([100, 150, 225, 300, 300]);
  });

  it("gives up at the deadline with the underlying error attached", async () => {
    let clock = 0;
    const probe = async () => {
      throw STARTING_UP();
    };

    await expect(
      waitForPostgresReady(url, {
        probe,
        timeoutMs: 1_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/did not become ready within 1000ms/);
  });

  it("rethrows a non-transient failure immediately", async () => {
    const probe = vi.fn(async () => {
      throw postgresError("28P01", "password authentication failed");
    });

    await expect(waitForPostgresReady(url, { probe, sleep: async () => {} })).rejects.toThrow(
      /password authentication failed/,
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("retries when a single attempt costs less than the deadline", async () => {
    // Each attempt burns its connect timeout before failing, the way a socket
    // that opens but never finishes the handshake does.
    let clock = 0;
    const probe = vi.fn(async () => {
      clock += 500;
      throw connectionError("CONNECT_TIMEOUT");
    });

    await expect(
      waitForPostgresReady(url, {
        probe,
        timeoutMs: 3_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/did not become ready within 3000ms/);

    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });

  it("spends the whole budget on one attempt when the probe outlives it", async () => {
    // Regression guard for the identify probes. Their connect timeout has to
    // stay under the budget they run within: a 5s connect timeout beneath a 3s
    // deadline fails on attempt one, so the backoff above never runs and a
    // postmaster replaying WAL reads as unidentifiable rather than as ours.
    let clock = 0;
    const probe = vi.fn(async () => {
      clock += 5_000;
      throw connectionError("CONNECT_TIMEOUT");
    });

    await expect(
      waitForPostgresReady(url, {
        probe,
        timeoutMs: 3_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/1 attempt\(s\), 5000ms elapsed/);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
