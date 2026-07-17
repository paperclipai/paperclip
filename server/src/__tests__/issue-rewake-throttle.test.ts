import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
} from "../services/issue-rewake-throttle.js";

const NOW = new Date("2026-07-17T00:00:00.000Z");
const run = (id: string, secondsAgo: number, status = "succeeded") => ({
  id,
  status,
  finishedAt: new Date(NOW.getTime() - secondsAgo * 1000),
});

describe("issue re-wake containment", () => {
  it("only throttles event-free state-poll wakes", () => {
    const base = { reason: "issue_continuation_needed", wakeCommentId: null, forceFreshSession: false, hasExplicitResume: false };
    expect(isThrottleCandidateIssueRewake(base)).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, wakeCommentId: "comment-1" })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_commented" })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
  });

  it("backs off repeated successful runs without delivery evidence", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [run("r2", 10), run("r1", 40)],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
  });

  it("resets on evidence, new input, or a failed run", () => {
    const samples = [run("r2", 10), run("r1", 40)];
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: samples,
      runIdsWithIssueProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: samples,
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [run("r2", 10, "failed"), run("r1", 40)],
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("uses a bounded exponential cooldown", () => {
    expect(computeIssueRewakeCooldownMs(2)).toBe(2 * 60_000);
    expect(computeIssueRewakeCooldownMs(3)).toBe(4 * 60_000);
    expect(computeIssueRewakeCooldownMs(100)).toBe(30 * 60_000);
  });
});
