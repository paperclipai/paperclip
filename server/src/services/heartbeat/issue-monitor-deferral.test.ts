import { describe, expect, it } from "vitest";
import {
  ISSUE_MONITOR_DEFERRAL_BASE_DELAY_MS,
  ISSUE_MONITOR_DEFERRAL_MAX_DELAY_MS,
  ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS,
  buildIssueMonitorDeferralState,
  issueMonitorDeferralDelayMs,
  readIssueMonitorDeferral,
} from "./issue-monitor-deferral.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../issue-execution-policy.js";

describe("issue monitor deferral state", () => {
  const scheduledAtIso = "2026-04-11T12:30:00.000Z";
  const now = new Date("2026-04-11T13:00:00.000Z");

  it("grows non-hold deferral backoff exponentially from 30s to a 60m cap", () => {
    expect(issueMonitorDeferralDelayMs(1)).toBe(ISSUE_MONITOR_DEFERRAL_BASE_DELAY_MS);
    expect(issueMonitorDeferralDelayMs(2)).toBe(60_000);
    expect(issueMonitorDeferralDelayMs(3)).toBe(2 * 60_000);
    expect(issueMonitorDeferralDelayMs(4)).toBe(4 * 60_000);
    expect(issueMonitorDeferralDelayMs(7)).toBe(32 * 60_000);
    expect(issueMonitorDeferralDelayMs(8)).toBe(ISSUE_MONITOR_DEFERRAL_MAX_DELAY_MS);
    expect(issueMonitorDeferralDelayMs(20)).toBe(ISSUE_MONITOR_DEFERRAL_MAX_DELAY_MS);
  });

  it("clamps backoff retryAt to timeoutAt when timeoutAt is sooner", () => {
    const timeoutAt = new Date(now.getTime() + 10_000);
    const { state, quietWindowMs } = buildIssueMonitorDeferralState({
      existing: null,
      scheduledAtIso,
      now,
      timeoutAt,
      reason: "monitor_dispatch_deferred",
      recoveryHold: null,
    });
    expect(state).toEqual({
      nextCheckAt: scheduledAtIso,
      deferredCount: 1,
      retryAt: timeoutAt.toISOString(),
      recoveryActionId: null,
      recoveryActionUpdatedAt: null,
      reason: "monitor_dispatch_deferred",
    });
    expect(quietWindowMs).toBe(ISSUE_MONITOR_DIAGNOSTIC_MIN_QUIET_MS);
  });

  it("parks on an active recovery hold with null retryAt and ignores deferral state after monitor replacement", () => {
    const { state } = buildIssueMonitorDeferralState({
      existing: null,
      scheduledAtIso,
      now,
      timeoutAt: null,
      reason: "execution_reconciliation_required",
      recoveryHold: {
        id: "11111111-1111-4111-8111-111111111111",
        updatedAtIso: "2026-04-11T12:00:00.123456Z",
      },
    });
    expect(state.retryAt).toBeNull();
    expect(state.recoveryActionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(readIssueMonitorDeferral({ monitorDeferral: state }, scheduledAtIso)).toEqual(state);
    expect(readIssueMonitorDeferral({ monitorDeferral: state }, "2026-04-11T12:45:00.000Z")).toBeNull();
  });

  it("preserves monitorDeferral on unrelated policy transitions and drops it on monitor replacement", () => {
    const policy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: scheduledAtIso,
        notes: "Watch external job",
        scheduledBy: "assignee",
      },
    });
    const deferral = {
      nextCheckAt: scheduledAtIso,
      deferredCount: 1,
      retryAt: null,
      recoveryActionId: "11111111-1111-4111-8111-111111111111",
      recoveryActionUpdatedAt: "2026-04-11T12:00:00.123456Z",
      reason: "execution_reconciliation_required",
    };
    const issue = {
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: scheduledAtIso,
          lastTriggeredAt: null,
          attemptCount: 0,
          notes: "Old notes",
          scheduledBy: "assignee",
          clearedAt: null,
          clearReason: null,
        },
        monitorDeferral: deferral,
      },
      monitorNextCheckAt: new Date(scheduledAtIso),
      monitorAttemptCount: 0,
      monitorNotes: "Old notes",
      monitorScheduledBy: "assignee",
    };

    // Unrelated edit with unchanged policy leaves executionState untouched in DB.
    const unchanged = applyIssueExecutionPolicyTransition({
      issue,
      policy,
      previousPolicy: policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: "user-1" },
      monitorExplicitlyUpdated: false,
    });
    expect(unchanged.patch.executionState).toBeUndefined();

    // Unrelated stage/policy rewrite that does not touch the monitor preserves monitorDeferral.
    const withReviewStage = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
      monitor: {
        nextCheckAt: scheduledAtIso,
        notes: "Watch external job",
        scheduledBy: "assignee",
      },
    });
    const stageRewrite = applyIssueExecutionPolicyTransition({
      issue: { ...issue, executionPolicy: withReviewStage },
      policy: withReviewStage,
      previousPolicy: withReviewStage,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: "22222222-2222-4222-8222-222222222222", userId: null },
      monitorExplicitlyUpdated: false,
    });
    expect((stageRewrite.patch.executionState as Record<string, unknown> | undefined)?.monitorDeferral).toEqual(deferral);

    const replacementPolicy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T14:00:00.000Z",
        notes: "Updated schedule",
        scheduledBy: "assignee",
      },
    });
    const replaced = applyIssueExecutionPolicyTransition({
      issue,
      policy: replacementPolicy,
      previousPolicy: policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: "user-1" },
      monitorExplicitlyUpdated: true,
    });
    expect((replaced.patch.executionState as Record<string, unknown> | undefined)?.monitorDeferral).toBeUndefined();
  });
});
