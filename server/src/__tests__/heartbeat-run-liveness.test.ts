import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_LEASE_TTL_MS,
  isAbandonedHeartbeatRun,
  type HeartbeatRunLivenessRow,
} from "../services/heartbeat-run-liveness.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");

function run(overrides: Partial<HeartbeatRunLivenessRow> = {}): HeartbeatRunLivenessRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    status: "running",
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    lastOutputAt: null,
    startedAt: null,
    updatedAt: null,
    createdAt: null,
    ...overrides,
  };
}

function ago(ms: number) {
  return new Date(NOW.getTime() - ms);
}

describe("isAbandonedHeartbeatRun (MAD-622)", () => {
  it("treats a process-less run silent past the lease as abandoned", () => {
    expect(
      isAbandonedHeartbeatRun(run({ lastOutputAt: ago(DEFAULT_RUN_LEASE_TTL_MS + 1000) }), { now: NOW }),
    ).toBe(true);
  });

  it("leaves a recently active run alone", () => {
    expect(
      isAbandonedHeartbeatRun(run({ lastOutputAt: ago(60_000) }), { now: NOW }),
    ).toBe(false);
  });

  it("leaves a run with a live process alone even past the lease", () => {
    // process.pid is by definition alive while this test runs.
    expect(
      isAbandonedHeartbeatRun(
        run({ processPid: process.pid, lastOutputAt: ago(DEFAULT_RUN_LEASE_TTL_MS * 10) }),
        { now: NOW },
      ),
    ).toBe(false);
  });

  it("falls back to startedAt, then updatedAt, for the lease clock", () => {
    expect(
      isAbandonedHeartbeatRun(run({ startedAt: ago(DEFAULT_RUN_LEASE_TTL_MS + 1) }), { now: NOW }),
    ).toBe(true);
    expect(
      isAbandonedHeartbeatRun(run({ updatedAt: ago(DEFAULT_RUN_LEASE_TTL_MS + 1) }), { now: NOW }),
    ).toBe(true);
    expect(
      isAbandonedHeartbeatRun(run({ updatedAt: ago(1000) }), { now: NOW }),
    ).toBe(false);
  });

  it("fails closed when there is no timestamp to reason about", () => {
    expect(isAbandonedHeartbeatRun(run(), { now: NOW })).toBe(false);
  });

  it("honours an explicit ttl override", () => {
    expect(
      isAbandonedHeartbeatRun(run({ lastOutputAt: ago(5_000) }), { now: NOW, ttlMs: 1_000 }),
    ).toBe(true);
  });
});

describe("never-started queued runs (MAD-891)", () => {
  const orphan = (overrides: Partial<HeartbeatRunLivenessRow> = {}) =>
    run({ status: "queued", startedAt: null, lastOutputAt: null, ...overrides });

  it("reaps a queued run that never started and is past the lease", () => {
    expect(
      isAbandonedHeartbeatRun(orphan({ createdAt: ago(DEFAULT_RUN_LEASE_TTL_MS + 1) }), { now: NOW }),
    ).toBe(true);
  });

  it("leaves a freshly queued run alone", () => {
    expect(
      isAbandonedHeartbeatRun(orphan({ createdAt: ago(60_000) }), { now: NOW }),
    ).toBe(false);
  });

  // The regression the ticket called out: `updatedAt` is bookkeeping, not
  // liveness. A stale queued run whose row keeps getting re-stamped would renew
  // its lease forever and make the reaper a no-op for exactly this case.
  it("ignores a bumped updatedAt and keeps the lease clock on createdAt", () => {
    expect(
      isAbandonedHeartbeatRun(
        orphan({ createdAt: ago(DEFAULT_RUN_LEASE_TTL_MS + 1), updatedAt: ago(1_000) }),
        { now: NOW },
      ),
    ).toBe(true);
  });

  // A run that did start is measured by its own activity, not by enqueue time.
  it("does not use createdAt once the run has started", () => {
    expect(
      isAbandonedHeartbeatRun(
        run({ createdAt: ago(DEFAULT_RUN_LEASE_TTL_MS * 10), startedAt: ago(1_000) }),
        { now: NOW },
      ),
    ).toBe(false);
  });
});
