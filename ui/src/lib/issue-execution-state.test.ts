import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import { executionDecisionStageForViewer } from "./issue-execution-state";

function pendingState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", userId: "local-board" },
    returnAssignee: { type: "agent", agentId: "agent-1" },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
    ...overrides,
  };
}

describe("executionDecisionStageForViewer", () => {
  it("returns the active board review stage", () => {
    expect(executionDecisionStageForViewer({
      issueStatus: "in_review",
      executionState: pendingState(),
      currentUserId: "local-board",
    })).toEqual({ stageLabel: "Review" });
  });

  it("returns the active board approval stage", () => {
    expect(executionDecisionStageForViewer({
      issueStatus: "in_review",
      executionState: pendingState({ currentStageType: "approval" }),
      currentUserId: "local-board",
    })).toEqual({ stageLabel: "Approval" });
  });

  it("returns null for a different participant or inactive stage", () => {
    expect(executionDecisionStageForViewer({
      issueStatus: "in_review",
      executionState: pendingState(),
      currentUserId: "user-2",
    })).toBeNull();
    expect(executionDecisionStageForViewer({
      issueStatus: "done",
      executionState: pendingState(),
      currentUserId: "local-board",
    })).toBeNull();
    expect(executionDecisionStageForViewer({
      issueStatus: "in_review",
      executionState: pendingState({ status: "completed" }),
      currentUserId: "local-board",
    })).toBeNull();
  });
});
