// Presentation helpers for dev-team gate approvals (A1 gate-profile). Gate
// approvals are ordinary `approvals` rows whose `type` is one of the gate_*
// kinds; their payload carries the designated agent and the plan root issue.

export const GATE_TYPES = [
  "gate_plan_approval",
  "gate_code_review",
  "gate_wiring_review",
] as const;

export type GateType = (typeof GATE_TYPES)[number];

export const GATE_LABEL: Record<GateType, string> = {
  gate_plan_approval: "Plan approval",
  gate_code_review: "Code review",
  gate_wiring_review: "Wiring review",
};

export const GATE_ORDER: Record<GateType, number> = {
  gate_plan_approval: 0,
  gate_code_review: 1,
  gate_wiring_review: 2,
};

export function isGateType(type: string): type is GateType {
  return (GATE_TYPES as readonly string[]).includes(type);
}

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function gateDesignatedAgentId(payload: Record<string, unknown> | null | undefined): string | null {
  return payloadString(payload, "designatedAgentId");
}

export function gatePlanRootIssueId(payload: Record<string, unknown> | null | undefined): string | null {
  return payloadString(payload, "planRootIssueId");
}
