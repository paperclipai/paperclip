import type { IssueExecutionState } from "@paperclipai/shared";

export type ExecutionGateView =
  | { kind: "none" }
  | {
      kind: "passive";
      stageLabel: string;
      participantLabel: string;
      passiveText: string;
    }
  | {
      kind: "self";
      stageLabel: string;
    };

interface DeriveInput {
  issueStatus: string;
  executionState: IssueExecutionState | null | undefined;
  currentUserId: string | null;
  agentName: (agentId: string | null) => string | null;
  userLabel: (userId: string | null) => string | null;
}

const STAGE_LABELS = {
  review: "Review",
  approval: "Approval",
} as const;

/**
 * Cheaper boolean for callers (e.g. IssueDetail's status row) that only need
 * to know whether the viewer should be routed through the ExecutionPolicyGate
 * for stage-advancing transitions. Mirrors the "self" branch in
 * {@link deriveExecutionGateView}.
 */
export function isViewerActiveExecutionParticipant(input: {
  issueStatus: string;
  executionState: IssueExecutionState | null | undefined;
  currentUserId: string | null;
}): boolean {
  if (input.issueStatus !== "in_review") return false;
  const state = input.executionState;
  if (!state) return false;
  if (state.status !== "pending") return false;
  const stageType = state.currentStageType;
  if (stageType !== "review" && stageType !== "approval") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  return (
    participant.type === "user" &&
    input.currentUserId !== null &&
    participant.userId === input.currentUserId
  );
}

/**
 * Keep the gate visible while a decision submit is in flight even if the issue
 * cache momentarily reports a non-self view. This protects the gate's local
 * state (typed comment, inline error, pending flag) from being thrown away
 * when an optimistic mutation flips `issue.status` to `done`/`in_progress`
 * — and therefore `kind` to `none` — before the server response lands.
 *
 * Returns the view to render, or `null` when the gate should not be mounted.
 */
export function stickyExecutionGateView(args: {
  current: ExecutionGateView;
  inFlight: boolean;
  lastSelf: ExecutionGateView | null;
}): ExecutionGateView | null {
  if (args.current.kind === "self") return args.current;
  if (args.current.kind === "passive") return args.current;
  if (args.inFlight && args.lastSelf?.kind === "self") return args.lastSelf;
  return null;
}

export function deriveExecutionGateView(input: DeriveInput): ExecutionGateView {
  if (input.issueStatus !== "in_review") return { kind: "none" };

  const state = input.executionState;
  if (!state) return { kind: "none" };

  // `idle` means the policy exists but the stage has not yet activated; `completed`
  // and `changes_requested` are non-actionable for an approver in this view.
  if (state.status !== "pending") return { kind: "none" };

  const stageType = state.currentStageType;
  if (stageType !== "review" && stageType !== "approval") return { kind: "none" };

  const stageLabel = STAGE_LABELS[stageType];
  const participant = state.currentParticipant;
  if (!participant) return { kind: "none" };

  if (
    participant.type === "user" &&
    input.currentUserId !== null &&
    participant.userId === input.currentUserId
  ) {
    return { kind: "self", stageLabel };
  }

  const rawLabel =
    participant.type === "agent"
      ? input.agentName(participant.agentId ?? null)
      : input.userLabel(participant.userId ?? null);
  const participantLabel =
    rawLabel ?? (participant.type === "agent" ? "an agent" : "a user");

  return {
    kind: "passive",
    stageLabel,
    participantLabel,
    passiveText: `${stageLabel} pending with ${participantLabel}`,
  };
}
