import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_WAKE_MAX_BACKOFF_MS,
  decideDependencyWakeCircuit,
  dependencyWakeBackoffMs,
  type DependencyWakeRunSample,
} from "./dependency-wake-circuit-breaker.js";

const now = Date.parse("2099-01-01T12:00:00.000Z");
let nextId = 0;

function run(status: string, minutesAgo: number, id = `run-${nextId++}`): DependencyWakeRunSample {
  return { id, status, finishedAt: new Date(now - minutesAgo * 60_000) };
}

function decide(runs: DependencyWakeRunSample[], latestBlockerChangeAt: Date | null = null) {
  return decideDependencyWakeCircuit({ runs, latestBlockerChangeAt, now });
}

describe("dependencyWakeBackoffMs", () => {
  it("grows by five per failure and is capped", () => {
    expect([1, 2, 3, 4].map(dependencyWakeBackoffMs)).toEqual([60_000, 300_000, 1_500_000, 7_500_000]);
    expect(dependencyWakeBackoffMs(50)).toBe(DEPENDENCY_WAKE_MAX_BACKOFF_MS);
  });
});

describe("decideDependencyWakeCircuit", () => {
  it("stays closed with no failed runs", () => {
    expect(decide([])).toEqual({ state: "closed", consecutiveFailures: 0 });
    expect(decide([run("succeeded", 0)])).toEqual({ state: "closed", consecutiveFailures: 0 });
  });

  it("backs off after a recent failure and closes once the backoff has passed", () => {
    expect(decide([run("failed", 0)])).toEqual({ state: "backoff", consecutiveFailures: 1, retryAt: now + 60_000 });
    expect(decide([run("failed", 2)]).state).toBe("closed");
    expect(decide([run("failed", 2), run("timed_out", 3)])).toMatchObject({ state: "backoff", consecutiveFailures: 2 });
  });

  it("probes again after the capped backoff, however long the streak", () => {
    const streak = Array.from({ length: 12 }, (_, index) => run("failed", 24 * 60 + 1 + index));
    expect(decide(streak)).toEqual({ state: "closed", consecutiveFailures: 12 });
  });

  it("counts a failed run once even when several wake receipts point to it", () => {
    expect(decide([run("failed", 3, "same"), run("failed", 3, "same"), run("failed", 3, "same")]))
      .toEqual({ state: "closed", consecutiveFailures: 1 });
  });

  it("treats interrupted runs as neutral", () => {
    expect(decide([run("interrupted", 0), run("failed", 1), run("failed", 2)]))
      .toMatchObject({ state: "backoff", consecutiveFailures: 2 });
  });

  it("resets on a run that did not fail, whatever woke it", () => {
    expect(decide([run("failed", 0), run("succeeded", 1), run("failed", 2), run("failed", 3)]))
      .toMatchObject({ state: "backoff", consecutiveFailures: 1 });
    expect(decide([run("cancelled", 0), run("failed", 1)])).toEqual({ state: "closed", consecutiveFailures: 0 });
  });

  it("orders runs by finish time", () => {
    expect(decide([run("failed", 2), run("succeeded", 3), run("failed", 0)]))
      .toMatchObject({ state: "backoff", consecutiveFailures: 2 });
  });

  it("ignores failures from before the latest blocker change", () => {
    const runs = [run("failed", 0), run("failed", 2), run("failed", 3)];
    expect(decide(runs, new Date(now - 90_000))).toMatchObject({ state: "backoff", consecutiveFailures: 1 });
    expect(decide(runs, new Date(now))).toEqual({ state: "closed", consecutiveFailures: 0 });
  });
});
