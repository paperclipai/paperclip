import { describe, expect, it } from "vitest";
import {
  ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS,
  ISSUE_BLOCKED_REPOLL_MAX_COOLDOWN_MS,
  ISSUE_BLOCKED_REPOLL_SAMPLE_LIMIT,
  computeBlockedRepollCooldownMs,
  evaluateBlockedRepollThrottle,
  isBlockedRepollCircuitBreakerStreak,
} from "../services/issue-rewake-throttle.js";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function run(over: Partial<{ id: string; status: string; finishedAt: Date | null; reportedBlocked: boolean }> = {}) {
  return { id: "r1", status: "succeeded", finishedAt: minutesAgo(10), reportedBlocked: true, ...over };
}

describe("blocked re-poll cooldown ladder", () => {
  it("escalates by doubling and caps at 24h", () => {
    expect(computeBlockedRepollCooldownMs(1)).toBe(ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS);
    expect(computeBlockedRepollCooldownMs(2)).toBe(2 * ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS);
    expect(computeBlockedRepollCooldownMs(3)).toBe(4 * ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS);
    expect(computeBlockedRepollCooldownMs(99)).toBe(ISSUE_BLOCKED_REPOLL_MAX_COOLDOWN_MS);
  });
});

describe("evaluateBlockedRepollThrottle", () => {
  const base = { now: NOW, issueStatus: "blocked", hasNewIssueInputSinceLastRun: false };

  it("holds a re-poll while the issue is blocked and nothing changed", () => {
    const d = evaluateBlockedRepollThrottle({ ...base, recentTerminalRuns: [run()] });
    expect(d.blocked).toBe(true);
    if (d.blocked) {
      expect(d.blockedStreak).toBe(1);
      expect(d.cooldownMs).toBe(ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS);
    }
  });

  it("escalates while the answer keeps coming back the same", () => {
    const d = evaluateBlockedRepollThrottle({
      ...base,
      recentTerminalRuns: [run({ id: "a" }), run({ id: "b", finishedAt: minutesAgo(200) }), run({ id: "c", finishedAt: minutesAgo(500) })],
    });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.cooldownMs).toBe(4 * ISSUE_BLOCKED_REPOLL_BASE_COOLDOWN_MS);
  });

  it("releases once the hold has elapsed", () => {
    const d = evaluateBlockedRepollThrottle({ ...base, recentTerminalRuns: [run({ finishedAt: minutesAgo(90) })] });
    expect(d.blocked).toBe(false);
  });

  // --- the safety properties: this must never strand a card -----------------

  it("never holds when the issue is no longer blocked", () => {
    for (const status of ["in_progress", "todo", "done", "in_review", null]) {
      expect(evaluateBlockedRepollThrottle({ ...base, issueStatus: status, recentTerminalRuns: [run()] }).blocked)
        .toBe(false);
    }
  });

  it("never holds when new issue input landed after the run", () => {
    const d = evaluateBlockedRepollThrottle({ ...base, hasNewIssueInputSinceLastRun: true, recentTerminalRuns: [run()] });
    expect(d.blocked).toBe(false);
  });

  it("never delays recovery after a failed, cancelled or interrupted run", () => {
    for (const status of ["failed", "cancelled", "interrupted"]) {
      expect(evaluateBlockedRepollThrottle({ ...base, recentTerminalRuns: [run({ status })] }).blocked).toBe(false);
    }
  });

  it("does not hold when the last run did not report blocked", () => {
    const d = evaluateBlockedRepollThrottle({ ...base, recentTerminalRuns: [run({ reportedBlocked: false })] });
    expect(d.blocked).toBe(false);
  });

  it("does not hold with no run history at all", () => {
    expect(evaluateBlockedRepollThrottle({ ...base, recentTerminalRuns: [] }).blocked).toBe(false);
  });

  it("stops the streak at the first run that broke the pattern", () => {
    const d = evaluateBlockedRepollThrottle({
      ...base,
      recentTerminalRuns: [run({ id: "a" }), run({ id: "b", reportedBlocked: false }), run({ id: "c" })],
    });
    expect(d.blocked).toBe(true);
    if (d.blocked) expect(d.blockedStreak).toBe(1);
  });
});

describe("isBlockedRepollCircuitBreakerStreak (TSMC-21379)", () => {
  it("stays closed below the full lookback sample", () => {
    expect(isBlockedRepollCircuitBreakerStreak(1)).toBe(false);
    expect(isBlockedRepollCircuitBreakerStreak(ISSUE_BLOCKED_REPOLL_SAMPLE_LIMIT - 1)).toBe(false);
  });

  it("opens once the streak has consumed the entire lookback sample", () => {
    expect(isBlockedRepollCircuitBreakerStreak(ISSUE_BLOCKED_REPOLL_SAMPLE_LIMIT)).toBe(true);
    expect(isBlockedRepollCircuitBreakerStreak(ISSUE_BLOCKED_REPOLL_SAMPLE_LIMIT + 5)).toBe(true);
  });
});
