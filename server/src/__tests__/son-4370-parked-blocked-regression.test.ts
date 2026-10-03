import { describe, expect, it } from "vitest";
import {
  decideQueuedRunStaleness,
  decideScheduledRetryGate,
  type QueuedRunFacts,
  type ScheduledRetryFacts,
} from "../modules/run-dispatch/domain/policy.js";
import {
  evaluateIssueRewakeThrottle,
  ISSUE_PROGRESS_ACTIVITY_ACTIONS,
} from "../services/issue-rewake-throttle.js";

// SON-4370 regression: parked `blocked` cards are inert to auto re-dispatch
// (SON-4179 pattern: blocked + UNMET external condition + repeated
// reconciler passes). Re-dispatch only on an unblocking event; checkout must
// not flip status; the churn guard must not be reset by run-authored
// keep-alive comments.

function scheduledFacts(overrides: Partial<ScheduledRetryFacts> = {}): ScheduledRetryFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: "issue-1",
    retryReasonKind: "other",
    enforceIssueExecutionLock: false,
    budgetBlock: null,
    agentInvokable: true,
    agentInvokabilityDetails: {},
    agentInvokabilityInvalidOrgChain: false,
    heartbeatWakeOnDemandEnabled: true,
    issueFound: true,
    issueStatus: "blocked",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    isNonAssigneeWorkspaceBusyRetry: false,
    reviewParticipant: {
      isInReview: false,
      hasParticipant: false,
      participantIsAgent: false,
      participantAgentId: null,
      currentStageType: null,
      currentParticipant: null,
    },
    activePauseHold: null,
    dependenciesBlocked: null,
    dispositionRepair: null,
    ...overrides,
  };
}

function queuedFacts(overrides: Partial<QueuedRunFacts> = {}): QueuedRunFacts {
  return {
    runId: "run-1",
    runAgentId: "agent-1",
    issueId: "issue-1",
    retryReasonKind: "other",
    issueFound: true,
    issueStatus: "blocked",
    issueAssigneeAgentId: "agent-1",
    issueExecutionRunId: "run-1",
    isResolvedInteractionContinuation: false,
    isInteractionWake: false,
    isAuthorizedSourceScopedRecovery: false,
    isNonAssigneeWorkspaceBusyRetry: false,
    resumeIntent: false,
    wakeCommentIdPresent: false,
    continuationParkApplies: false,
    continuationParksExecutor: false,
    continuationSummaryBody: null,
    wakeReason: "issue_assignment_recovery",
    retryReason: "assignment_recovery",
    reviewParticipant: {
      isInReview: false,
      hasParticipant: false,
      participantIsAgent: false,
      participantAgentId: null,
      currentStageType: null,
      currentParticipant: null,
    },
    ...overrides,
  };
}

describe("SON-4370 parked blocked is inert to auto re-dispatch", () => {
  it("suppresses a scheduled retry promotion on a parked blocked card (SON-4179 pattern)", () => {
    const decision = decideScheduledRetryGate(scheduledFacts(), new Date());
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.errorCode).toBe("issue_blocked");
  });

  it("repeated reconciler passes keep suppressing: the decision is stateless and stable", () => {
    for (let pass = 0; pass < 5; pass += 1) {
      expect(decideScheduledRetryGate(scheduledFacts(), new Date()).allowed).toBe(false);
      expect(decideQueuedRunStaleness(queuedFacts(), new Date()).stale).toBe(true);
    }
  });

  it("marks a queued auto re-dispatch stale when the issue is parked blocked", () => {
    const decision = decideQueuedRunStaleness(queuedFacts(), new Date());
    expect(decision.stale).toBe(true);
    if (decision.stale) expect(decision.errorCode).toBe("issue_blocked");
  });

  it("a new comment on a parked blocked card still dispatches (exactly one wake path)", () => {
    const decision = decideQueuedRunStaleness(
      queuedFacts({ retryReason: null, wakeCommentIdPresent: true }),
      new Date(),
    );
    expect(decision.stale).toBe(false);
  });

  it("an explicit unblocking event (assignee/status change, manual dispatch) may re-dispatch", () => {
    expect(
      decideScheduledRetryGate(scheduledFacts({ unblockingEventPresent: true }), new Date()).allowed,
    ).toBe(true);
    expect(
      decideQueuedRunStaleness(queuedFacts({ unblockingEventPresent: true }), new Date()).stale,
    ).toBe(false);
  });

  it("an interaction wake is an unblocking event", () => {
    expect(decideQueuedRunStaleness(queuedFacts({ retryReason: null, isInteractionWake: true }), new Date()).stale).toBe(false);
  });

  it("a resolved interaction is an unblocking event", () => {
    expect(decideQueuedRunStaleness(queuedFacts({
      retryReason: null,
      isResolvedInteractionContinuation: true,
    }), new Date()).stale).toBe(false);
  });

  it("non-blocked statuses keep the previous behavior (in_progress control)", () => {
    expect(decideQueuedRunStaleness(queuedFacts({ issueStatus: "in_progress" }), new Date()).stale).toBe(false);
  });

  it("native safe replacement stays suppressed on blocked", () => {
    const decision = decideScheduledRetryGate(
      scheduledFacts({ retryReasonKind: "native_safe_replacement", unblockingEventPresent: true }),
      new Date(),
    );
    expect(decision.allowed).toBe(false);
  });

  it("does not let an automatic retry with inherited wake markers restart a parked card", () => {
    const decision = decideQueuedRunStaleness(queuedFacts({
      retryReason: "transient_failure",
      wakeReason: "issue_commented",
      wakeCommentIdPresent: true,
      resumeIntent: true,
      isInteractionWake: true,
      unblockingEventPresent: false,
    }), new Date());
    expect(decision).toMatchObject({ stale: true, errorCode: "issue_blocked" });
  });
});

describe("SON-4370 churn guard", () => {
  it("run-authored comments do not count as issue progress", () => {
    expect(ISSUE_PROGRESS_ACTIVITY_ACTIONS).not.toContain("issue.comment_added");
  });

  it("three no-progress terminal runs in 6h engage the throttle and raise one attention flag", () => {
    const now = new Date("2026-09-29T20:30:00Z");
    const runs = [1, 2, 3].map((i) => ({
      id: `run-${i}`,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - i * 30_000),
    }));
    const decision = evaluateIssueRewakeThrottle({
      now,
      recentTerminalRuns: runs,
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) expect(decision.raiseAttentionFlag).toBe(true);
  });

  it("keep-alive-comment runs count as no-progress (streak forms across them)", () => {
    // After the SON-4370 change, a run whose only output was a comment has an
    // empty progress set, so the streak survives it.
    const now = new Date("2026-09-29T20:30:00Z");
    const runs = [1, 2].map((i) => ({
      id: `run-${i}`,
      status: "succeeded",
      finishedAt: new Date(now.getTime() - i * 30_000),
    }));
    const decision = evaluateIssueRewakeThrottle({
      now,
      recentTerminalRuns: runs,
      runIdsWithIssueProgress: new Set(),
      hasNewIssueInputSinceLastRun: false,
    });
    expect(decision.blocked).toBe(true);
    if (decision.blocked) expect(decision.noProgressStreak).toBe(2);
  });
});
