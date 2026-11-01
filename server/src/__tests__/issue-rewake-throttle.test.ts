import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ISSUE_REWAKE_BASE_COOLDOWN_MS,
  ISSUE_REWAKE_MAX_COOLDOWN_MS,
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  computeIssueRewakeCooldownMs,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
  resolveCommentOnlyProgressStreakCap,
} from "../services/issue-rewake-throttle.ts";

const NOW = new Date("2026-07-12T18:14:00.000Z");

function runSample(input: {
  id: string;
  status?: string;
  finishedSecondsAgo: number;
}) {
  return {
    id: input.id,
    status: input.status ?? "succeeded",
    finishedAt: new Date(NOW.getTime() - input.finishedSecondsAgo * 1000),
  };
}

describe("isThrottleCandidateIssueRewake", () => {
  const base = {
    reason: "issue_assigned",
    wakeCommentId: null,
    requestedByActorType: "system" as const,
    forceFreshSession: false,
    hasExplicitResume: false,
  };

  it("throttles state-poll reasons and reason-less invokes", () => {
    expect(isThrottleCandidateIssueRewake(base)).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: null })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_continuation_needed" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_assignment_recovery" })).toBe(true);
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "issue_graph_liveness_backstop" })).toBe(true);
  });

  it("keeps agent comments throttle-eligible without granting human comment privileges", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
    })).toBe(true);
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      wakeCommentId: "comment-1",
      requestedByActorType: "user",
    })).toBe(false);
  });

  it("never throttles trusted explicit escalation wakes", () => {
    expect(isThrottleCandidateIssueRewake({ ...base, forceFreshSession: true })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(false);
  });

  it("keeps agent-authored explicit resume comments throttle-eligible", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_reopened_via_comment",
      wakeCommentId: "comment-1",
      requestedByActorType: "agent",
      hasExplicitResume: true,
    })).toBe(true);
  });

  it("passes event-shaped wake reasons through", () => {
    for (const reason of [
      "issue_commented",
      "issue_comment_mentioned",
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_monitor_due",
      "process_lost_retry",
      "run_liveness_continuation",
    ]) {
      expect(isThrottleCandidateIssueRewake({ ...base, reason })).toBe(false);
    }
  });
});

describe("computeIssueRewakeCooldownMs", () => {
  it("starts at the base cooldown and doubles per extra no-progress run, capped", () => {
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 1)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    expect(computeIssueRewakeCooldownMs(ISSUE_REWAKE_NO_PROGRESS_THRESHOLD + 3)).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 8);
    expect(computeIssueRewakeCooldownMs(100)).toBe(ISSUE_REWAKE_MAX_COOLDOWN_MS);
  });
});

describe("evaluateIssueRewakeThrottle", () => {
  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        now: NOW,
        recentTerminalRuns: [],
        runIdsWithIssueProgress: new Set(),
        runIdsWithCommentOnlyProgress: new Set(),
        hasNewIssueInputSinceLastRun: false,
      }),
    ).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("blocks inside the cooldown once the streak reaches the threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(2);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS);
      expect(decision.nextAllowedAt.getTime()).toBe(
        NOW.getTime() - 10_000 + ISSUE_REWAKE_BASE_COOLDOWN_MS,
      );
    }
  });

  it("allows again after the cooldown elapses", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 1 }),
        runSample({ id: "r1", finishedSecondsAgo: ISSUE_REWAKE_BASE_COOLDOWN_MS / 1000 + 30 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 2 });
  });

  it("escalates the cooldown as the streak grows", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 30 }),
        runSample({ id: "r2", finishedSecondsAgo: 60 }),
        runSample({ id: "r1", finishedSecondsAgo: 90 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("resets at the most recent run with issue-visible progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(["r2"]),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 1 });
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(),
      hasNewIssueInputSinceLastRun: true,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

});

// The comment-only exemption cap is read from `process.env` once, at module
// load. These tests pin behavior that only holds for the in-repo default
// (1), so they load their own isolated copy of the module with that
// override var explicitly cleared first — otherwise an operator override
// left in the ambient test-process environment (a legitimately supported
// setting) would make these assertions fail even though nothing is broken.
describe("evaluateIssueRewakeThrottle (comment-only exemption cap, default)", () => {
  const previousOverride = process.env.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK;
  let throttle: typeof import("../services/issue-rewake-throttle.ts");

  beforeAll(async () => {
    delete process.env.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK;
    vi.resetModules();
    throttle = await import("../services/issue-rewake-throttle.ts");
  });

  afterAll(() => {
    if (previousOverride === undefined) {
      delete process.env.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK;
    } else {
      process.env.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK = previousOverride;
    }
    vi.resetModules();
  });

  it("confirms the in-repo default cap this file's narrative depends on, independent of ambient env overrides", () => {
    // The single-exemption test below and the cap-exceeded test below only
    // mean what they say if the default is exactly 1 — pin it so a future
    // change to the default fails loudly here instead of silently changing
    // what those two tests actually exercise.
    expect(throttle.ISSUE_REWAKE_COMMENT_ONLY_PROGRESS_MAX_STREAK).toBe(1);
  });

  it("still exempts a single comment-only run, matching a one-off status update", () => {
    const decision = throttle.evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(["r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("stops exempting once consecutive comment-only runs exceed the cap, so a loop that only ever comments still escalates", () => {
    // Every run in this sample posted a comment and nothing else — the exact
    // shape of a heartbeat protocol that always confirms "nothing to report."
    // Without the cap, the newest run's comment would exempt every
    // evaluation forever; this is the gap #14458's sibling bug left in the
    // throttle after the stranded-sweep lane was bounded.
    const runs = [
      runSample({ id: "r4", finishedSecondsAgo: 10 }),
      runSample({ id: "r3", finishedSecondsAgo: 40 }),
      runSample({ id: "r2", finishedSecondsAgo: 70 }),
      runSample({ id: "r1", finishedSecondsAgo: 100 }),
    ];
    const decision = throttle.evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: runs,
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(["r4", "r3", "r2", "r1"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(4);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 4);
    }
  });

  it("stops converting comment-only runs at the first real progress action further back", () => {
    // r4/r3/r2 are consecutive comment-only runs past the cap; r1 (oldest)
    // has real (non-comment) progress. The conversion must still stop at r1
    // exactly as the original "break on first progress" check always did —
    // this proves the exhausted-cap path doesn't walk past genuine progress
    // once it starts counting comment-only runs as no-progress.
    const decision = throttle.evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 40 }),
        runSample({ id: "r2", finishedSecondsAgo: 70 }),
        runSample({ id: "r1", finishedSecondsAgo: 100 }),
      ],
      runIdsWithIssueProgress: new Set(["r1"]),
      runIdsWithCommentOnlyProgress: new Set(["r4", "r3", "r2"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(3);
      expect(decision.cooldownMs).toBe(ISSUE_REWAKE_BASE_COOLDOWN_MS * 2);
    }
  });

  it("stops exempting an alternating comment/empty-run pattern once the comment-only count among them exceeds the cap", () => {
    // Regression for the exact gap Greptile flagged on this PR: an agent
    // alternating a comment-only run with a truly empty one (no comment, no
    // other progress) must not be able to hold its exemption open forever
    // just because no single *consecutive* comment-only run longer than the
    // cap ever appears.
    const decision = throttle.evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: [
        runSample({ id: "c3", finishedSecondsAgo: 10 }),
        runSample({ id: "e2", finishedSecondsAgo: 40 }),
        runSample({ id: "c2", finishedSecondsAgo: 70 }),
        runSample({ id: "e1", finishedSecondsAgo: 100 }),
        runSample({ id: "c1", finishedSecondsAgo: 130 }),
      ],
      runIdsWithIssueProgress: new Set(),
      runIdsWithCommentOnlyProgress: new Set(["c3", "c2", "c1"]),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) {
      expect(decision.noProgressStreak).toBe(5);
    }
  });
});

describe("resolveCommentOnlyProgressStreakCap", () => {
  it("normalizes missing, blank, non-finite, and sub-floor overrides to a usable integer", () => {
    expect(resolveCommentOnlyProgressStreakCap(undefined)).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("   ")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("not-a-number")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("Infinity")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("0")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("-5")).toBe(1);
    expect(resolveCommentOnlyProgressStreakCap("3.9")).toBe(3);
    expect(resolveCommentOnlyProgressStreakCap("5")).toBe(5);
    expect(resolveCommentOnlyProgressStreakCap(undefined, 2)).toBe(2);
  });

  it("clamps an override at or past the run sample window, so the exhaustion check stays reachable", () => {
    // The exhaustion check requires the leading comment-only streak to
    // exceed this cap, but that streak can never be longer than
    // ISSUE_REWAKE_RUN_SAMPLE_LIMIT (8) runs. A cap of 8 or higher could
    // therefore never be exceeded, silently disabling the bound for any
    // operator who set a value that size or larger.
    expect(resolveCommentOnlyProgressStreakCap("7")).toBe(7);
    expect(resolveCommentOnlyProgressStreakCap("8")).toBe(7);
    expect(resolveCommentOnlyProgressStreakCap("100")).toBe(7);
  });
});
