import { createHash } from "node:crypto";
import { parseIssueExecutionState } from "../issue-execution-policy.js";

/** Internal provenance: public wake routes never copy this option from payloads. */
export type StageHandoffIdentity = { statusVersion: number; stateDigest: string };
export const STAGE_HANDOFF_KEY = "_paperclipStageHandoff";

export function stageHandoffIdentity(statusVersion: number, state: unknown): StageHandoffIdentity {
  const parsed = parseIssueExecutionState(state);
  // Monitor observations and editable instructions do not create a new handoff.
  const generation = parsed && { status: parsed.status, currentStageId: parsed.currentStageId,
    currentStageType: parsed.currentStageType, currentParticipant: parsed.currentParticipant,
    returnAssignee: parsed.returnAssignee, lastDecisionId: parsed.lastDecisionId };
  return { statusVersion, stateDigest: createHash("sha256")
    .update(JSON.stringify(generation)).digest("hex") };
}

export function isCurrentStageHandoff(issue: {
  status: string; statusVersion: number; executionState: unknown; assigneeAgentId: string | null;
}, agentId: string, reason: string | null, identity: StageHandoffIdentity): boolean {
  const state = parseIssueExecutionState(issue.executionState);
  if (!state || issue.assigneeAgentId !== agentId || issue.statusVersion !== identity.statusVersion ||
      stageHandoffIdentity(issue.statusVersion, state).stateDigest !== identity.stateDigest) return false;
  if (state.status === "pending" && issue.status === "in_review" && state.currentStageId &&
      ["review", "approval"].includes(state.currentStageType ?? "")) {
    return state.currentParticipant?.type === "agent" && state.currentParticipant.agentId === agentId &&
      reason === (state.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested");
  }
  return state.status === "changes_requested" && ["todo", "in_progress"].includes(issue.status) &&
    state.returnAssignee?.type === "agent" && state.returnAssignee.agentId === agentId &&
    reason === "execution_changes_requested";
}
