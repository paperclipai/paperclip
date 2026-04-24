import { describe, expect, it } from "vitest";
import {
  classifyOwnedIssueWakeActionability,
  isIdleCanonicalDeliveryReview,
} from "../services/issue-actionability.ts";

describe("issue actionability", () => {
  it("recognizes canonical delivery review with no linked execution run as idle", () => {
    expect(isIdleCanonicalDeliveryReview({
      status: "in_review",
      executionRunId: null,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    })).toBe(true);
  });

  it("does not treat canonical delivery review with a linked execution run as idle", () => {
    expect(isIdleCanonicalDeliveryReview({
      status: "in_review",
      executionRunId: "run-1",
      executionRunStatus: "running",
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    })).toBe(false);
  });

  it("treats canonical delivery review linked to a completed run as idle again", () => {
    expect(isIdleCanonicalDeliveryReview({
      status: "in_review",
      executionRunId: "run-1",
      executionRunStatus: "completed",
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    })).toBe(true);
  });

  it("does not guess idle when a linked execution run exists but its state is unknown", () => {
    expect(isIdleCanonicalDeliveryReview({
      status: "in_review",
      executionRunId: "run-1",
      executionRunStatus: undefined,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    })).toBe(false);
  });

  it("keeps QA-owned idle canonical review wakeable when capacity exists and no idle cooldown applies", () => {
    const result = classifyOwnedIssueWakeActionability({
      nowMs: Date.now(),
      hasFreeSlot: true,
      status: "in_review",
      assigneeAgentId: "qa-1",
      assigneeRole: "qa",
      assigneeStatus: "idle",
      title: "Review cart release gate",
      description: null,
      identifier: "COMA-1290",
      projectName: "Comandero",
      workIntent: "delivery",
      executionRunId: null,
      executionRunStatus: undefined,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      latestStructuredTruthType: null,
      hasLatestStructuredTruthComment: false,
      latestStructuredTruthCreatedAtMs: null,
      latestWakeAgentId: null,
      latestWakeStatus: null,
      latestWakeReason: null,
      latestOpsCommentHasIdleWakeMarker: false,
      latestOpsCommentCreatedAtMs: null,
      latestAssigneeRunStatus: null,
      latestAssigneeRunCreatedAtMs: null,
      latestAssigneeRunFinishedAtMs: null,
      idleWakeCooldownMs: 30 * 60 * 1000,
      recoveryRewakeCooldownMs: 60 * 60 * 1000,
      structuredTruthFreshnessWindowMs: 6 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      kind: "ready",
      reason: "canonical delivery review is idle with no linked execution run",
    });
  });

  it("does not let stale blocker truth suppress idle canonical review forever", () => {
    const nowMs = Date.now();
    const result = classifyOwnedIssueWakeActionability({
      nowMs,
      hasFreeSlot: true,
      status: "in_review",
      assigneeAgentId: "qa-1",
      assigneeRole: "qa",
      assigneeStatus: "idle",
      title: "Review cart release gate",
      description: null,
      identifier: "COMA-1290",
      projectName: "Comandero",
      workIntent: "delivery",
      executionRunId: null,
      executionRunStatus: undefined,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      latestStructuredTruthType: "blocker",
      hasLatestStructuredTruthComment: true,
      latestStructuredTruthCreatedAtMs: nowMs - 7 * 60 * 60 * 1000,
      latestWakeAgentId: null,
      latestWakeStatus: null,
      latestWakeReason: null,
      latestOpsCommentHasIdleWakeMarker: false,
      latestOpsCommentCreatedAtMs: null,
      latestAssigneeRunStatus: null,
      latestAssigneeRunCreatedAtMs: null,
      latestAssigneeRunFinishedAtMs: null,
      idleWakeCooldownMs: 30 * 60 * 1000,
      recoveryRewakeCooldownMs: 60 * 60 * 1000,
      structuredTruthFreshnessWindowMs: 6 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      kind: "ready",
      reason: "canonical delivery review is idle with no linked execution run",
    });
  });

  it("blocks duplicate wakes when a pending wakeup already exists", () => {
    const result = classifyOwnedIssueWakeActionability({
      nowMs: Date.now(),
      hasFreeSlot: true,
      status: "in_review",
      assigneeAgentId: "qa-1",
      assigneeRole: "qa",
      assigneeStatus: "idle",
      title: "Review cart release gate",
      description: null,
      identifier: "COMA-1290",
      projectName: "Comandero",
      workIntent: "delivery",
      executionRunId: null,
      executionRunStatus: undefined,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      latestStructuredTruthType: null,
      hasLatestStructuredTruthComment: false,
      latestStructuredTruthCreatedAtMs: null,
      latestWakeAgentId: "qa-1",
      latestWakeStatus: "queued",
      latestWakeReason: "operations_idle_assignment_wakeup",
      latestOpsCommentHasIdleWakeMarker: false,
      latestOpsCommentCreatedAtMs: null,
      latestAssigneeRunStatus: null,
      latestAssigneeRunCreatedAtMs: null,
      latestAssigneeRunFinishedAtMs: null,
      idleWakeCooldownMs: 30 * 60 * 1000,
      recoveryRewakeCooldownMs: 60 * 60 * 1000,
      structuredTruthFreshnessWindowMs: 6 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "pending wakeup already exists",
    });
  });

  it("does not re-wake idle review when QA auto-merge is already blocked", () => {
    const result = classifyOwnedIssueWakeActionability({
      nowMs: Date.now(),
      hasFreeSlot: true,
      status: "in_review",
      assigneeAgentId: "qa-1",
      assigneeRole: "qa",
      assigneeStatus: "idle",
      title: "Review cart release gate",
      description: null,
      identifier: "COMA-1290",
      projectName: "Comandero",
      workIntent: "delivery",
      executionRunId: null,
      executionRunStatus: undefined,
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          userId: null,
        },
        returnAssignee: {
          type: "agent",
          agentId: "33333333-3333-4333-8333-333333333333",
          userId: null,
        },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      latestStructuredTruthType: null,
      hasLatestStructuredTruthComment: false,
      latestStructuredTruthCreatedAtMs: null,
      latestNonOperationsCommentBody: "[merge-blocked]\nQA validation passed, but auto-merge is blocked.",
      latestWakeAgentId: null,
      latestWakeStatus: null,
      latestWakeReason: null,
      latestOpsCommentHasIdleWakeMarker: false,
      latestOpsCommentCreatedAtMs: null,
      latestAssigneeRunStatus: null,
      latestAssigneeRunCreatedAtMs: null,
      latestAssigneeRunFinishedAtMs: null,
      idleWakeCooldownMs: 30 * 60 * 1000,
      recoveryRewakeCooldownMs: 60 * 60 * 1000,
      structuredTruthFreshnessWindowMs: 6 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      kind: "blocked",
      reason: "qa merge is blocked pending external resolution",
    });
  });
});
