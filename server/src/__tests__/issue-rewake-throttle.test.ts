import { describe, expect, it } from "vitest";
import {
  ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
  ISSUE_REWAKE_STOP_THRESHOLD,
  buildIssueRewakeStallDisclosure,
  evaluateIssueRewakeThrottle,
  isThrottleCandidateIssueRewake,
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
    expect(isThrottleCandidateIssueRewake({ ...base, reason: "finish_successful_run_handoff" })).toBe(true);
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
    // A resume escapes only on a wake that is not itself a state poll. The
    // server attaches a resume to its own throttled wakes, so an
    // unconditional escape here is an escape for everything.
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      hasExplicitResume: true,
    })).toBe(false);
    expect(isThrottleCandidateIssueRewake({ ...base, hasExplicitResume: true })).toBe(true);
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

  it("lets a person through: an operator invoke is the door out of a stopped issue", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: null,
      requestedByActorType: "user",
    })).toBe(false);
    // An agent invoking itself is not that door.
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: null,
      requestedByActorType: "agent",
    })).toBe(true);
  });

  it("throttles the successful-run handoff even though it carries a resume", () => {
    // The real handoff payload always has `resumeFromRunId`, so it arrives here
    // with hasExplicitResume set. Reading the resume escape first is what made
    // an earlier version of this rule inert on every actual dispatch.
    for (const hasExplicitResume of [false, true]) {
      expect(isThrottleCandidateIssueRewake({
        ...base,
        reason: "finish_successful_run_handoff",
        requestedByActorType: "system",
        hasExplicitResume,
      })).toBe(true);
    }
  });

  it("keeps the resume escape for wakes that are not throttled reasons", () => {
    expect(isThrottleCandidateIssueRewake({
      ...base,
      reason: "issue_commented",
      requestedByActorType: "system",
      hasExplicitResume: true,
    })).toBe(false);
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

describe("evaluateIssueRewakeThrottle", () => {
  it("allows when there is no run history", () => {
    expect(
      evaluateIssueRewakeThrottle({
        recentTerminalRuns: [],
        runIdsWithIssueProgress: new Set(),
        newIssueInputAt: null,
      }),
    ).toEqual({ action: "proceed", noProgressStreak: 0 });
  });

  it("allows below the no-progress threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [runSample({ id: "r1", finishedSecondsAgo: 10 })],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 1 });
  });

  it("discloses once when the streak reaches the disclosure threshold", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({
      action: "disclose",
      noProgressStreak: ISSUE_REWAKE_NO_PROGRESS_THRESHOLD,
      lastRunFinishedAt: new Date(NOW.getTime() - 10_000),
    });
  });

  it("stops once the disclosed wake also produced no progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({
      action: "stop",
      noProgressStreak: ISSUE_REWAKE_STOP_THRESHOLD,
      lastRunFinishedAt: new Date(NOW.getTime() - 10_000),
    });
  });

  it("stays stopped however old the stalled runs get", () => {
    // The defect this replaces, in both its forms: a cooldown that expired, and
    // a lookback window the stalled runs would eventually age out of. Either
    // way the next poll woke a full-price session that again did nothing,
    // forever. Age is not an input to this decision.
    for (const secondsAgo of [10, 3_600, 86_400]) {
      const decision = evaluateIssueRewakeThrottle({
        recentTerminalRuns: [
          runSample({ id: "r4", finishedSecondsAgo: secondsAgo }),
          runSample({ id: "r3", finishedSecondsAgo: secondsAgo + 30 }),
          runSample({ id: "r2", finishedSecondsAgo: secondsAgo + 60 }),
          runSample({ id: "r1", finishedSecondsAgo: secondsAgo + 90 }),
        ],
        runIdsWithIssueProgress: new Set(),
        newIssueInputAt: null,
      });
      expect(decision.action).toBe("stop");
      expect(decision.noProgressStreak).toBe(4);
    }
  });

  it("breaks the streak on a run with no finish time rather than reasoning past it", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        { id: "r3", status: "succeeded", finishedAt: null },
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 0 });
  });

  it("resets at the most recent run with issue-visible progress", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(["r2"]),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 1 });
  });

  it("does not delay recovery after a failed run", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r2", status: "failed", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: null,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 0 });
  });

  it("allows when new issue input landed after the last run", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: new Date(NOW.getTime() - 5_000),
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 0 });
  });

  it("gives new input a whole fresh episode, not one borrowed wake", () => {
    // The subtle version of the same defect: input arrives, one wake is let
    // through, that run also does nothing, and the next poll counts it together
    // with the spent streak and stops immediately. Runs before the input are
    // not part of this episode at all.
    const inputAt = new Date(NOW.getTime() - 50_000);
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r4", finishedSecondsAgo: 10 }),
        runSample({ id: "r3", finishedSecondsAgo: 70 }),
        runSample({ id: "r2", finishedSecondsAgo: 100 }),
        runSample({ id: "r1", finishedSecondsAgo: 130 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: inputAt,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 1 });
  });

  it("counts input at exactly a run's finish time as opening the episode", () => {
    // The boundary the SQL lower bound has to match: `gt` there would have
    // dropped this row, turning this proceed into a disclose.
    const boundary = new Date(NOW.getTime() - 40_000);
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r2", finishedSecondsAgo: 10 }),
        runSample({ id: "r1", finishedSecondsAgo: 40 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: boundary,
    });
    expect(decision).toEqual({ action: "proceed", noProgressStreak: 1 });
  });

  it("ignores input older than the runs it is meant to explain", () => {
    const decision = evaluateIssueRewakeThrottle({
      recentTerminalRuns: [
        runSample({ id: "r3", finishedSecondsAgo: 10 }),
        runSample({ id: "r2", finishedSecondsAgo: 40 }),
        runSample({ id: "r1", finishedSecondsAgo: 70 }),
      ],
      runIdsWithIssueProgress: new Set(),
      newIssueInputAt: new Date(NOW.getTime() - 600_000),
    });
    expect(decision.action).toBe("stop");
    expect(decision.noProgressStreak).toBe(3);
  });
});

describe("buildIssueRewakeStallDisclosure", () => {
  it("states the evidence and that this is the last wake, without prescribing an outcome", () => {
    const text = buildIssueRewakeStallDisclosure({
      noProgressStreak: 2,
      lastRunFinishedAt: new Date("2026-07-12T18:13:50.000Z"),
    });
    expect(text).toContain("last 2 runs");
    expect(text).toContain("2026-07-12T18:13:50.000Z");
    expect(text).toContain("only further wake");
    // Every disposition the agent may choose is offered; none is mandated.
    for (const option of ["finish it", "block it", "record a finding", "escalate"]) {
      expect(text).toContain(option);
    }
  });
});
