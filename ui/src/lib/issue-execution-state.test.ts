import { describe, expect, it } from "vitest";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  deriveExecutionGateView,
  isViewerActiveExecutionParticipant,
} from "./issue-execution-state";

const noopAgentName = (id: string | null) => (id ? `Agent ${id}` : null);
const noopUserLabel = (id: string | null) => (id ? `User ${id}` : null);

const baseState: IssueExecutionState = {
  status: "pending",
  currentStageId: "stage-1",
  currentStageIndex: 0,
  currentStageType: "approval",
  currentParticipant: { type: "user", agentId: null, userId: "u-active" },
  returnAssignee: null,
  reviewRequest: null,
  completedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
};

const callDerive = (overrides: Partial<Parameters<typeof deriveExecutionGateView>[0]>) =>
  deriveExecutionGateView({
    issueStatus: "in_review",
    executionState: baseState,
    currentUserId: "u-active",
    agentName: noopAgentName,
    userLabel: noopUserLabel,
    ...overrides,
  });

describe("deriveExecutionGateView", () => {
  it("returns none when issue is not in_review", () => {
    expect(callDerive({ issueStatus: "in_progress" })).toEqual({ kind: "none" });
  });

  it("returns none when executionState is null or undefined", () => {
    expect(callDerive({ executionState: null })).toEqual({ kind: "none" });
    expect(callDerive({ executionState: undefined })).toEqual({ kind: "none" });
  });

  it("returns none when executionState.status is not 'pending'", () => {
    for (const status of ["idle", "completed", "changes_requested"] as const) {
      expect(callDerive({ executionState: { ...baseState, status } })).toEqual({ kind: "none" });
    }
  });

  it("returns none when stage type is neither review nor approval", () => {
    expect(
      callDerive({
        executionState: { ...baseState, currentStageType: null },
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns none when currentParticipant is null", () => {
    expect(
      callDerive({
        executionState: { ...baseState, currentParticipant: null },
      }),
    ).toEqual({ kind: "none" });
  });

  it("returns 'self' for matching user participant when currentUserId matches", () => {
    const view = callDerive({});

    expect(view).toEqual({
      kind: "self",
      stageLabel: "Approval",
    });
  });

  it("uses 'Review' as the stage label for review stages", () => {
    const view = callDerive({
      executionState: { ...baseState, currentStageType: "review" },
    });

    expect(view).toEqual({ kind: "self", stageLabel: "Review" });
  });

  it("returns passive when participant is a different user", () => {
    const view = callDerive({
      currentUserId: "u-other",
      executionState: {
        ...baseState,
        currentParticipant: { type: "user", agentId: null, userId: "u-active" },
      },
    });

    expect(view).toEqual({
      kind: "passive",
      stageLabel: "Approval",
      participantLabel: "User u-active",
      passiveText: "Approval pending with User u-active",
    });
  });

  it("returns passive when currentUserId is null", () => {
    const view = callDerive({ currentUserId: null });

    expect(view.kind).toBe("passive");
    if (view.kind === "passive") {
      expect(view.passiveText).toBe("Approval pending with User u-active");
    }
  });

  it("returns passive with agent label when participant is an agent", () => {
    const view = callDerive({
      executionState: {
        ...baseState,
        currentParticipant: { type: "agent", agentId: "a-1", userId: null },
      },
    });

    expect(view).toEqual({
      kind: "passive",
      stageLabel: "Approval",
      participantLabel: "Agent a-1",
      passiveText: "Approval pending with Agent a-1",
    });
  });

  it("falls back to a generic participant label when name lookups return null", () => {
    const view = callDerive({
      currentUserId: "u-other",
      agentName: () => null,
      userLabel: () => null,
    });

    expect(view.kind).toBe("passive");
    if (view.kind === "passive") {
      // graceful fallback: still produces non-empty text, no "null" leakage
      expect(view.passiveText.startsWith("Approval pending with")).toBe(true);
      expect(view.passiveText.includes("null")).toBe(false);
    }
  });

  it("does NOT match self when participant is a user but currentUserId is null", () => {
    const view = callDerive({ currentUserId: null });
    expect(view.kind).not.toBe("self");
  });
});

describe("isViewerActiveExecutionParticipant", () => {
  const baseInput = {
    issueStatus: "in_review",
    executionState: baseState,
    currentUserId: "u-active",
  };

  it("returns true for the matching user participant", () => {
    expect(isViewerActiveExecutionParticipant(baseInput)).toBe(true);
  });

  it("returns false when the issue is not in_review", () => {
    expect(
      isViewerActiveExecutionParticipant({ ...baseInput, issueStatus: "in_progress" }),
    ).toBe(false);
  });

  it("returns false when the participant is a different user", () => {
    expect(
      isViewerActiveExecutionParticipant({ ...baseInput, currentUserId: "u-other" }),
    ).toBe(false);
  });

  it("returns false for an agent participant", () => {
    expect(
      isViewerActiveExecutionParticipant({
        ...baseInput,
        executionState: {
          ...baseState,
          currentParticipant: { type: "agent", agentId: "a-1", userId: null },
        },
      }),
    ).toBe(false);
  });

  it("returns false when currentUserId is null", () => {
    expect(
      isViewerActiveExecutionParticipant({ ...baseInput, currentUserId: null }),
    ).toBe(false);
  });

  it("returns false when executionState.status is changes_requested", () => {
    expect(
      isViewerActiveExecutionParticipant({
        ...baseInput,
        executionState: { ...baseState, status: "changes_requested" },
      }),
    ).toBe(false);
  });
});
