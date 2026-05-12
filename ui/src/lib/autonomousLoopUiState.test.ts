import { describe, expect, it } from "vitest";
import type { AutonomousLoopState } from "../api/issues";
import { deriveAutonomousLoopUiState } from "./autonomousLoopUiState";

function baseState(patch: Partial<AutonomousLoopState> = {}): AutonomousLoopState {
  return {
    enabled: true,
    status: "executing",
    goal: "Ship autonomous creator traffic ops workflow",
    iteration: 2,
    maxIterations: 5,
    currentDecision: {
      iteration: 1,
      decision: "next_iteration",
      nextTaskTitle: "Continue safe internal planning",
    },
    supervisor: {
      attentionRequired: false,
      reason: null,
      recoveryAction: "none",
      owner: "none",
      userVisible: true,
    },
    ...patch,
  };
}

describe("deriveAutonomousLoopUiState", () => {
  it("treats operator-only stale approval repair as internal even when status still says approval_required", () => {
    const uiState = deriveAutonomousLoopUiState(
      baseState({
        status: "approval_required",
        currentDecision: {
          iteration: 1,
          decision: "approval_required",
          nextTaskTitle: "Deploy stale loop slice",
        },
        supervisor: {
          attentionRequired: true,
          reason: "ceo_loop_decision_stale",
          recoveryAction: "repair_loop_decision",
          owner: "operator",
          userVisible: false,
        },
      }),
    );

    expect(uiState.supervisor.kind).toBe("operator_repair");
    expect(uiState.supervisor.label).toBe("Needs repair");
    expect(uiState.supervisor.needsAttention).toBe(true);
    expect(uiState.decisionLabel).toBe("ceo_loop_decision_stale");
    expect(uiState.nextTaskTitle).toBeNull();
  });

  it("keeps user-visible approval gates as approval attention with the next task visible", () => {
    const uiState = deriveAutonomousLoopUiState(
      baseState({
        status: "approval_required",
        currentDecision: {
          iteration: 2,
          decision: "approval_required",
          nextTaskTitle: "Approve safe continuation",
        },
        supervisor: {
          attentionRequired: true,
          reason: "needs_user_approval",
          recoveryAction: "request_user_approval",
          owner: "user",
          userVisible: true,
        },
      }),
    );

    expect(uiState.supervisor.kind).toBe("user_attention");
    expect(uiState.supervisor.label).toBe("Needs approval");
    expect(uiState.decisionLabel).toBe("approval_required");
    expect(uiState.nextTaskTitle).toBe("Approve safe continuation");
  });

  it("uses progress labels without losing typed clear supervisor state", () => {
    const uiState = deriveAutonomousLoopUiState(
      baseState({
        progressLabel: "Iteration 2 of 5 · validating",
        supervisor: {
          attentionRequired: false,
          reason: null,
          recoveryAction: "none",
          owner: "none",
          userVisible: false,
        },
      }),
    );

    expect(uiState.progress).toBe("Iteration 2 of 5 · validating");
    expect(uiState.supervisor.kind).toBe("clear");
    expect(uiState.supervisor.needsAttention).toBe(false);
  });
});
