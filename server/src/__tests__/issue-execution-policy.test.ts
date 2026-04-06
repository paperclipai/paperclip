import { describe, expect, it } from "vitest";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

describe("issue execution policy transitions", () => {
  const coderAgentId = "11111111-1111-4111-8111-111111111111";
  const qaAgentId = "22222222-2222-4222-8222-222222222222";
  const ctoUserId = "cto-user";
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      {
        type: "review",
        participants: [{ type: "agent", agentId: qaAgentId }],
      },
      {
        type: "approval",
        participants: [{ type: "user", userId: ctoUserId }],
      },
    ],
  });

  it("routes executor completion into review", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: coderAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: coderAgentId },
      commentBody: "Implemented the feature",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(qaAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      returnAssignee: { type: "agent", agentId: coderAgentId },
    });
    expect(result.decision).toBeUndefined();
  });

  it("returns review changes to the prior executor", () => {
    const reviewStageId = policy?.stages[0]?.id ?? "review-stage";
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "in_progress",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "Needs another pass on edge cases",
    });

    expect(result.patch.status).toBe("in_progress");
    expect(result.patch.assigneeAgentId).toBe(coderAgentId);
    expect(result.patch.executionState).toMatchObject({
      status: "changes_requested",
      currentStageType: "review",
      returnAssignee: { type: "agent", agentId: coderAgentId },
      lastDecisionOutcome: "changes_requested",
    });
    expect(result.decision).toMatchObject({
      stageId: reviewStageId,
      stageType: "review",
      outcome: "changes_requested",
    });
  });

  it("advances approved review work into approval", () => {
    const reviewStageId = policy?.stages[0]?.id ?? "review-stage";
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: qaAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: coderAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: qaAgentId },
      commentBody: "QA signoff complete",
    });

    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBeNull();
    expect(result.patch.assigneeUserId).toBe(ctoUserId);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "approval",
      completedStageIds: [reviewStageId],
      currentParticipant: { type: "user", userId: ctoUserId },
    });
    expect(result.decision).toMatchObject({
      stageId: reviewStageId,
      stageType: "review",
      outcome: "approved",
    });
  });
});
