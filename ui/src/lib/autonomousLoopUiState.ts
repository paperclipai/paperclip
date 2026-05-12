import type { AutonomousLoopState } from "../api/issues";

export type AutonomousLoopSupervisorUiState =
  | {
      kind: "clear";
      label: "clear";
      needsAttention: false;
    }
  | {
      kind: "operator_repair";
      label: "Needs repair";
      needsAttention: true;
      reason: string | null;
      owner: string;
      recoveryAction: string;
      userVisible: false;
    }
  | {
      kind: "user_attention";
      label: "Needs approval";
      needsAttention: true;
      reason: string | null;
      owner: string;
      recoveryAction: string;
      userVisible: true | null;
    };

export type AutonomousLoopUiState = {
  progress: string;
  decisionLabel: string;
  nextTaskTitle: string | null;
  supervisor: AutonomousLoopSupervisorUiState;
};

function formatProgress(state: AutonomousLoopState): string {
  if (state.progressLabel) return state.progressLabel;
  if (typeof state.iteration === "number" && typeof state.maxIterations === "number") {
    return `${state.iteration} / ${state.maxIterations}`;
  }
  if (typeof state.iteration === "number") return `Iteration ${state.iteration}`;
  return "—";
}

function deriveSupervisorState(state: AutonomousLoopState): AutonomousLoopSupervisorUiState {
  const supervisor = state.supervisor;
  if (supervisor?.attentionRequired && supervisor.userVisible === false) {
    return {
      kind: "operator_repair",
      label: "Needs repair",
      needsAttention: true,
      reason: supervisor.reason ?? null,
      owner: supervisor.owner ?? "operator",
      recoveryAction: supervisor.recoveryAction ?? "manual_review",
      userVisible: false,
    };
  }

  if (state.status === "approval_required" || supervisor?.attentionRequired) {
    return {
      kind: "user_attention",
      label: "Needs approval",
      needsAttention: true,
      reason: supervisor?.reason ?? null,
      owner: supervisor?.owner ?? "user",
      recoveryAction: supervisor?.recoveryAction ?? "request_user_approval",
      userVisible: supervisor?.userVisible === null ? null : true,
    };
  }

  return {
    kind: "clear",
    label: "clear",
    needsAttention: false,
  };
}

function deriveDecisionLabel(state: AutonomousLoopState, supervisor: AutonomousLoopSupervisorUiState): string {
  if (supervisor.kind === "operator_repair") {
    return supervisor.reason ?? state.status ?? "internal_repair";
  }
  return state.currentDecision?.decision ?? state.status ?? "unknown";
}

function deriveNextTaskTitle(state: AutonomousLoopState, supervisor: AutonomousLoopSupervisorUiState): string | null {
  if (supervisor.kind === "operator_repair") return null;
  return state.currentDecision?.nextTaskTitle ?? state.planner?.nextTaskTitle ?? null;
}

export function deriveAutonomousLoopUiState(state: AutonomousLoopState): AutonomousLoopUiState {
  const supervisor = deriveSupervisorState(state);
  return {
    progress: formatProgress(state),
    decisionLabel: deriveDecisionLabel(state, supervisor),
    nextTaskTitle: deriveNextTaskTitle(state, supervisor),
    supervisor,
  };
}
