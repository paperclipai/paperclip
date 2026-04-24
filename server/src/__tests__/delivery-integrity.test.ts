import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyDeliveryIntegrity, resolveIssueWorkIntent } from "../services/delivery-integrity.ts";

describe("delivery integrity", () => {
  it("classifies ticket-creation trust audits as non-delivery work intent", () => {
    expect(resolveIssueWorkIntent({
      assigneeRole: "qa",
      issueText: [
        "Cart trust audit — eliminate any source of doubt.",
        "This is a trust validation and failure detection exercise.",
        "The audit is not complete until concrete issues are created.",
        "For every P0 and P1 issue: create a NEW issue.",
      ].join("\n"),
    })).toBe("audit");
  });

  it("normalizes non-delivery review rows back to todo while preserving a healthy builder", () => {
    expect(classifyDeliveryIntegrity({
      issue: {
        status: "in_review",
        workflowTemplateKey: null,
        workflowLaneRole: null,
        assigneeAgentId: "agent-engineer",
        assigneeRole: "engineer",
        assigneeStatus: "idle",
        assigneeUserId: null,
        workIntent: "ticket_authoring",
        executionPolicy: null,
        executionState: null,
        executionRunId: null,
      },
      run: null,
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toMatchObject({
      kind: "normalize_non_delivery_review",
      nextStatus: "todo",
      assigneeAgentId: "agent-engineer",
      clearExecutionState: true,
    });
  });

  it("normalizes non-delivery review rows off dead QA owners", () => {
    expect(classifyDeliveryIntegrity({
      issue: {
        status: "in_review",
        workflowTemplateKey: null,
        workflowLaneRole: null,
        assigneeAgentId: "agent-qa-dead",
        assigneeRole: "qa",
        assigneeStatus: "error",
        assigneeUserId: null,
        workIntent: "audit",
        executionPolicy: null,
        executionState: null,
        executionRunId: null,
      },
      run: null,
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toMatchObject({
      kind: "normalize_non_delivery_review",
      nextStatus: "todo",
      assigneeAgentId: null,
      clearExecutionState: true,
    });
  });

  it("marks security workflow lanes as capability-blocked when no specialist exists", () => {
    expect(classifyDeliveryIntegrity({
      issue: {
        status: "todo",
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "security",
        assigneeAgentId: null,
        assigneeRole: null,
        assigneeStatus: null,
        assigneeUserId: null,
        workIntent: "delivery",
        executionPolicy: null,
        executionState: null,
        executionRunId: null,
      },
      run: null,
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toMatchObject({
      kind: "capability_blocked",
      blockingRole: "security",
    });
  });

  it("normalizes non-QA workflow lanes out of standalone review state", () => {
    expect(classifyDeliveryIntegrity({
      issue: {
        status: "in_review",
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "security",
        assigneeAgentId: "agent-security",
        assigneeRole: "security",
        assigneeStatus: "idle",
        assigneeUserId: null,
        qaReviewerAgentId: "agent-qa",
        workIntent: "delivery",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: randomUUID(),
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: "agent-qa", userId: null }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: "agent-qa" },
          returnAssignee: { type: "agent", agentId: "agent-security" },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
        executionRunId: null,
      },
      run: null,
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
      },
    })).toMatchObject({
      kind: "normalize_workflow_lane_review_drift",
      clearExecutionState: true,
      workIntent: "delivery",
    });
  });

  it("normalizes stale QA review metadata off non-QA workflow lanes even when they are already todo", () => {
    expect(classifyDeliveryIntegrity({
      issue: {
        status: "todo",
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "security",
        assigneeAgentId: "agent-security",
        assigneeRole: "security",
        assigneeStatus: "idle",
        assigneeUserId: null,
        qaReviewerAgentId: "agent-qa",
        workIntent: "delivery",
        executionPolicy: null,
        executionState: null,
        executionRunId: null,
      },
      run: null,
      eligibleSpecialistRoleIds: {
        security: ["agent-security"],
      },
    })).toMatchObject({
      kind: "normalize_workflow_lane_review_drift",
      clearExecutionState: true,
      workIntent: "delivery",
    });
  });

  it("flags active run ownership mismatches against the canonical review owner", () => {
    const qaAgentId = randomUUID();
    const engineerAgentId = randomUUID();
    const platformAgentId = randomUUID();
    const stageId = randomUUID();

    expect(classifyDeliveryIntegrity({
      issue: {
        status: "in_review",
        workflowTemplateKey: null,
        workflowLaneRole: null,
        assigneeAgentId: qaAgentId,
        assigneeRole: "qa",
        assigneeStatus: "running",
        assigneeUserId: null,
        workIntent: "delivery",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: qaAgentId, userId: null }],
          }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: qaAgentId },
          returnAssignee: { type: "agent", agentId: engineerAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
        executionRunId: "run-1",
      },
      run: {
        id: "run-1",
        agentId: platformAgentId,
        status: "running",
      },
      eligibleSpecialistRoleIds: {
        security: [],
      },
    })).toMatchObject({
      kind: "run_owner_mismatch",
      canonicalAgentId: qaAgentId,
      runAgentId: platformAgentId,
    });
  });
});
