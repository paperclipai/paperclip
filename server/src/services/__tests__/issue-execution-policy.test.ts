import { describe, expect, it } from "vitest";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../issue-execution-policy.js";
import type { IssueExecutionPolicy, IssueExecutionState } from "@paperclipai/shared";

// AnytimeInterview agent IDs
const PREPLANNER_AGENT_ID = "ae58c263-0580-4908-a443-001519161e20";
const EXECUTOR_AGENT_ID = "9063a20f-d593-4e5f-8eb3-10f740d60cf7";
const TEST_AGENT_ID = "4ae217b8-4f5b-47d4-a81e-ab3be7605379";
const SUPERVISOR_AGENT_ID = "7784778d-f7e6-4be2-815e-839e4cf5c163";

/**
 * Build the AnytimeInterview 3-stage execution policy.
 * Pre-planner is the initial assignee (not a stage).
 * Stages: Executor (review) → Test (review) → Supervisor (review).
 */
function anytimeInterviewPolicy(): IssueExecutionPolicy {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: EXECUTOR_AGENT_ID }] },
      { type: "review", participants: [{ type: "agent", agentId: TEST_AGENT_ID }] },
      { type: "review", participants: [{ type: "agent", agentId: SUPERVISOR_AGENT_ID }] },
    ],
  })!;
}

describe("AnytimeInterview execution policy handoff chain", () => {
  it("test_execution_policy_advances_from_preplanner_to_executor", () => {
    const policy = anytimeInterviewPolicy();

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: PREPLANNER_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: PREPLANNER_AGENT_ID },
      commentBody: "Pre-planning complete",
    });

    // Should intercept done → route to Executor (stage 1)
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(EXECUTOR_AGENT_ID);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: EXECUTOR_AGENT_ID },
      returnAssignee: { type: "agent", agentId: PREPLANNER_AGENT_ID },
    });
  });

  it("test_execution_policy_advances_from_executor_to_test", () => {
    const policy = anytimeInterviewPolicy();
    const executorStageId = policy.stages[0].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: EXECUTOR_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: executorStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: EXECUTOR_AGENT_ID },
          returnAssignee: { type: "agent", agentId: PREPLANNER_AGENT_ID },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT_ID },
      commentBody: "Execution complete",
    });

    // Should advance to Test (stage 2)
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(TEST_AGENT_ID);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: TEST_AGENT_ID },
      completedStageIds: [executorStageId],
    });
    expect(result.decision).toMatchObject({
      stageId: executorStageId,
      stageType: "review",
      outcome: "approved",
    });
  });

  it("test_execution_policy_advances_from_test_to_supervisor", () => {
    const policy = anytimeInterviewPolicy();
    const executorStageId = policy.stages[0].id;
    const testStageId = policy.stages[1].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: TEST_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: testStageId,
          currentStageIndex: 1,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: TEST_AGENT_ID },
          returnAssignee: { type: "agent", agentId: PREPLANNER_AGENT_ID },
          completedStageIds: [executorStageId],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: TEST_AGENT_ID },
      commentBody: "Tests passed",
    });

    // Should advance to Supervisor (stage 3)
    expect(result.patch.status).toBe("in_review");
    expect(result.patch.assigneeAgentId).toBe(SUPERVISOR_AGENT_ID);
    expect(result.patch.executionState).toMatchObject({
      status: "pending",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: SUPERVISOR_AGENT_ID },
      completedStageIds: expect.arrayContaining([executorStageId, testStageId]),
    });
    expect(result.decision).toMatchObject({
      stageId: testStageId,
      stageType: "review",
      outcome: "approved",
    });
  });

  it("test_execution_policy_completes_after_supervisor", () => {
    const policy = anytimeInterviewPolicy();
    const executorStageId = policy.stages[0].id;
    const testStageId = policy.stages[1].id;
    const supervisorStageId = policy.stages[2].id;

    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: SUPERVISOR_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: supervisorStageId,
          currentStageIndex: 2,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: SUPERVISOR_AGENT_ID },
          returnAssignee: { type: "agent", agentId: PREPLANNER_AGENT_ID },
          completedStageIds: [executorStageId, testStageId],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: SUPERVISOR_AGENT_ID },
      commentBody: "Approved and complete",
    });

    // Should be fully complete — no further reassignment
    expect(result.patch.executionState).toMatchObject({
      status: "completed",
      completedStageIds: expect.arrayContaining([executorStageId, testStageId, supervisorStageId]),
      lastDecisionOutcome: "approved",
    });
    // Status should NOT be overridden — caller can set done
    expect(result.patch.status).toBeUndefined();
    expect(result.decision).toMatchObject({
      stageId: supervisorStageId,
      stageType: "review",
      outcome: "approved",
    });
  });

  it("test_execution_policy_does_not_fire_without_config", () => {
    const result = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: PREPLANNER_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: null,
        executionState: null,
      },
      policy: null,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: PREPLANNER_AGENT_ID },
    });

    // No auto-reassignment — backward compatibility
    expect(result.patch).toEqual({});
    expect(result.decision).toBeUndefined();
  });

  it("test_execution_policy_uses_correct_agent_ids", () => {
    const policy = anytimeInterviewPolicy();

    // Verify stage participants match the configured agent IDs exactly
    expect(policy.stages).toHaveLength(3);
    expect(policy.stages[0].participants[0].agentId).toBe(EXECUTOR_AGENT_ID);
    expect(policy.stages[1].participants[0].agentId).toBe(TEST_AGENT_ID);
    expect(policy.stages[2].participants[0].agentId).toBe(SUPERVISOR_AGENT_ID);

    // Verify full chain: Pre-planner → Executor → Test → Supervisor
    const step1 = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: PREPLANNER_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: PREPLANNER_AGENT_ID },
      commentBody: "Done",
    });
    expect(step1.patch.assigneeAgentId).toBe(EXECUTOR_AGENT_ID);

    const step2 = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: EXECUTOR_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: step1.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: EXECUTOR_AGENT_ID },
      commentBody: "Done",
    });
    expect(step2.patch.assigneeAgentId).toBe(TEST_AGENT_ID);

    const step3 = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_review",
        assigneeAgentId: TEST_AGENT_ID,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: step2.patch.executionState as IssueExecutionState,
      },
      policy,
      requestedStatus: "done",
      requestedAssigneePatch: {},
      actor: { agentId: TEST_AGENT_ID },
      commentBody: "Done",
    });
    expect(step3.patch.assigneeAgentId).toBe(SUPERVISOR_AGENT_ID);
  });
});
