import {
  GATE_APPROVAL_TYPES,
  type GateApprovalType,
  type IssueBlockedInboxReason,
} from "@paperclipai/shared";

// Pure helpers for the advisory dev-team gate protocol. No DB access here — the
// plan service composes these specs and performs the inserts, which keeps the
// mapping/precedence logic unit-testable in isolation.

const GATE_TYPE_SET = new Set<string>(Object.values(GATE_APPROVAL_TYPES));

export function isGateApprovalType(type: string): type is GateApprovalType {
  return GATE_TYPE_SET.has(type);
}

// urlKey of the agent each gate is routed to. Resolved by the plan service
// against company agents; a missing match falls back to the board.
export const GATE_DESIGNATED_URL_KEY: Record<GateApprovalType, string> = {
  [GATE_APPROVAL_TYPES.planApproval]: "architect",
  [GATE_APPROVAL_TYPES.codeReview]: "code-reviewer",
  [GATE_APPROVAL_TYPES.wiringReview]: "wiring-expert",
};

const GATE_TYPE_TO_REASON: Record<GateApprovalType, IssueBlockedInboxReason> = {
  [GATE_APPROVAL_TYPES.planApproval]: "pending_plan_approval",
  [GATE_APPROVAL_TYPES.codeReview]: "pending_code_review",
  [GATE_APPROVAL_TYPES.wiringReview]: "pending_wiring_review",
};

export function gateTypeToReason(type: GateApprovalType): IssueBlockedInboxReason {
  return GATE_TYPE_TO_REASON[type];
}

// Lower number = higher precedence. When one issue carries multiple pending
// gates (a leaf has both code-review and wiring), the board surfaces the
// highest-precedence one; the next gate appears only after the prior is decided.
const GATE_PRECEDENCE: Record<GateApprovalType, number> = {
  [GATE_APPROVAL_TYPES.planApproval]: 0,
  [GATE_APPROVAL_TYPES.codeReview]: 1,
  [GATE_APPROVAL_TYPES.wiringReview]: 2,
};

export function gatePrecedence(type: string): number {
  return isGateApprovalType(type) ? GATE_PRECEDENCE[type] : Number.POSITIVE_INFINITY;
}

export interface GateApprovalSpec {
  type: GateApprovalType;
  issueId: string;
  // Designated agent resolved by urlKey; null = board fallback.
  designatedAgentId: string | null;
}

export interface GateActivationInput {
  planRootIssueId: string;
  leafIssueIds: string[];
  // urlKey → agentId for the three gate roles (null/absent = board fallback).
  designatedByUrlKey: Record<string, string | null>;
}

// Builds the full set of gate approvals for a dev_team plan activation:
// one plan-approval gate on the plan root, plus code-review + wiring-review
// gates on every materialized leaf.
export function buildGateApprovalsForActivation(
  input: GateActivationInput,
): GateApprovalSpec[] {
  const resolve = (type: GateApprovalType): string | null =>
    input.designatedByUrlKey[GATE_DESIGNATED_URL_KEY[type]] ?? null;

  const specs: GateApprovalSpec[] = [
    {
      type: GATE_APPROVAL_TYPES.planApproval,
      issueId: input.planRootIssueId,
      designatedAgentId: resolve(GATE_APPROVAL_TYPES.planApproval),
    },
  ];

  for (const leafId of input.leafIssueIds) {
    specs.push({
      type: GATE_APPROVAL_TYPES.codeReview,
      issueId: leafId,
      designatedAgentId: resolve(GATE_APPROVAL_TYPES.codeReview),
    });
    specs.push({
      type: GATE_APPROVAL_TYPES.wiringReview,
      issueId: leafId,
      designatedAgentId: resolve(GATE_APPROVAL_TYPES.wiringReview),
    });
  }

  return specs;
}

// Fix 3 (B1 gap-fix) — interim C1 hard `done` guard, pure decision.
// Returns the unmet preconditions for closing a dev_team-gated issue: an open PR
// and approved code + wiring review gates. Empty array = ready to close. The
// caller decides what to do with the reasons (throw for an agent actor, log an
// override for a user/board actor). Non-dev_team or non-`done` transitions are
// never gated.
export function evaluateDevTeamDoneReadiness(input: {
  gateProfile: string | null | undefined;
  targetStatus: string;
  currentStatus: string;
  prUrl: string | null;
  // Statuses of THIS issue's code-review + wiring-review gate approvals.
  reviewGateStatuses: string[];
}): { reasons: string[] } {
  if (input.targetStatus !== "done" || input.currentStatus === "done") return { reasons: [] };
  if (input.gateProfile !== "dev_team") return { reasons: [] };

  const reasons: string[] = [];
  if (!input.prUrl) reasons.push("missing_pr");
  if (input.reviewGateStatuses.some((status) => status !== "approved")) reasons.push("gates_pending");
  return { reasons };
}
