import type {
  OwnerAckAuditStatus,
  OwnerAckGateActorType,
  OwnerAckGateDecision,
  OwnerAckGateMode,
} from "@paperclipai/shared";

export type EvaluateOwnerAckGateInput = {
  mode: OwnerAckGateMode;
  actorType: OwnerAckGateActorType;
  auditStatus: OwnerAckAuditStatus;
  reasons: string[];
};

export function evaluateOwnerAckGate(input: EvaluateOwnerAckGateInput): OwnerAckGateDecision {
  const unsafe = input.auditStatus !== "covered";
  const enforceForActor =
    input.mode === "enforce_all" || (input.mode === "enforce_agent" && input.actorType === "agent");
  const action = unsafe && enforceForActor ? "block" : "allow";
  const wouldBlock = unsafe && (input.mode === "observe" || action === "block");

  return {
    mode: input.mode,
    actorType: input.actorType,
    action,
    wouldBlock,
    observed: input.mode === "observe" && unsafe,
    bypassAvailable: action === "block" && input.actorType === "board",
    reasons: unsafe ? buildReasons(input.auditStatus, input.reasons) : [],
  };
}

function buildReasons(auditStatus: OwnerAckAuditStatus, reasons: string[]) {
  if (reasons.length > 0) return reasons;
  return [`owner_ack_${auditStatus}`];
}
