import type { IssueExecutionState } from "@paperclipai/shared";

export interface ExecutionDecisionStage {
  stageLabel: "Review" | "Approval";
}

const STAGE_LABELS = {
  review: "Review",
  approval: "Approval",
} as const;

export function executionDecisionStageForViewer(input: {
  issueStatus: string;
  executionState: IssueExecutionState | null | undefined;
  currentUserId: string | null;
}): ExecutionDecisionStage | null {
  if (input.issueStatus !== "in_review") return null;
  const state = input.executionState;
  if (state?.status !== "pending") return null;
  if (state.currentStageType !== "review" && state.currentStageType !== "approval") return null;
  const participant = state.currentParticipant;
  if (
    participant?.type !== "user" ||
    !input.currentUserId ||
    participant.userId !== input.currentUserId
  ) {
    return null;
  }
  return { stageLabel: STAGE_LABELS[state.currentStageType] };
}
