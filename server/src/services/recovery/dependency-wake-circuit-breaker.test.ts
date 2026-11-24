import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_WAKE_FAILURE_BACKOFF_MS,
  DEPENDENCY_WAKE_FAILURE_LIMIT,
  decideDependencyWakeCircuit,
  type DependencyWakeHistoryEntry,
} from "./dependency-wake-circuit-breaker.js";

const now = Date.parse("2099-01-01T12:00:00.000Z");
const blockers = ["b", "a"];

function failed(minutesAgo: number, blockerIssueIds: unknown = ["a", "b"]): DependencyWakeHistoryEntry {
  return { blockerIssueIds, runStatus: "failed", runFinishedAt: new Date(now - minutesAgo * 60_000) };
}

describe("decideDependencyWakeCircuit", () => {
  it("stays closed with no history", () => {
    expect(decideDependencyWakeCircuit([], blockers, now)).toEqual({ state: "closed", consecutiveFailures: 0 });
  });

  it("backs off after a recent failure and closes once the backoff has passed", () => {
    expect(decideDependencyWakeCircuit([failed(0)], blockers, now)).toEqual({
      state: "backoff",
      consecutiveFailures: 1,
      retryAt: now + DEPENDENCY_WAKE_FAILURE_BACKOFF_MS[0],
    });
    expect(decideDependencyWakeCircuit([failed(2)], blockers, now).state).toBe("closed");
    expect(decideDependencyWakeCircuit([failed(2), failed(3)], blockers, now)).toMatchObject({
      state: "backoff",
      consecutiveFailures: 2,
    });
  });

  it("opens after the failure limit, however old the failures are", () => {
    const history = Array.from({ length: DEPENDENCY_WAKE_FAILURE_LIMIT }, (_, index) => failed(600 + index));
    expect(decideDependencyWakeCircuit(history, blockers, now).state).toBe("open");
  });

  it("treats timed-out runs as failures and ignores wakes that never ran", () => {
    const history: DependencyWakeHistoryEntry[] = [
      { blockerIssueIds: ["a", "b"], runStatus: null, runFinishedAt: null },
      { ...failed(600), runStatus: "timed_out" },
      failed(601),
      failed(602),
    ];
    expect(decideDependencyWakeCircuit(history, blockers, now).state).toBe("open");
  });

  it("resets on a run that did not fail", () => {
    const history = [failed(600), { blockerIssueIds: ["a", "b"], runStatus: "succeeded", runFinishedAt: null }, failed(700), failed(701)];
    expect(decideDependencyWakeCircuit(history, blockers, now)).toEqual({ state: "closed", consecutiveFailures: 1 });
  });

  it("resets when the blocker set changed", () => {
    const history = [failed(600, ["a", "b", "c"]), failed(601), failed(602)];
    expect(decideDependencyWakeCircuit(history, blockers, now)).toEqual({ state: "closed", consecutiveFailures: 0 });
    expect(decideDependencyWakeCircuit([failed(600, "not-a-list")], blockers, now).state).toBe("closed");
  });
});
