import { createHash } from "node:crypto";
export { executionGrantApprovalDetails } from "@paperclipai/shared";

export const EXECUTION_GRANT_POLICY_VERSION = 1;

export type ExecutionGrantDecision =
  | { kind: "agent"; decisionId: string; approverAgentId: string }
  | { kind: "board"; decisionId: string; approverUserId: string };

export interface ExecutionGrant {
  companyId: string;
  issueId: string;
  proposerAgentId: string;
  executorAgentId: string;
  targetAgentId: string;
  operation: "agent_config:update";
  targetRevisionId: string | null;
  requestHash: string;
  expiresAt: Date;
  policyVersion: number;
  decision: ExecutionGrantDecision;
  consumedAt: Date | null;
}

export interface ExecutionGrantAttempt {
  companyId: string;
  executorAgentId: string;
  targetAgentId: string;
  operation: "agent_config:update";
  targetRevisionId: string | null;
  requestHash: string;
  decisionStewardAgentId: string;
  currentPolicyVersion: number;
  now: Date;
}

export type ExecutionGrantDenial =
  | "company_mismatch"
  | "self_approval"
  | "approver_is_executor"
  | "proposer_is_executor"
  | "steward_powers"
  | "already_consumed"
  | "expired"
  | "policy_version_changed"
  | "unauthorized_executor"
  | "target_changed"
  | "operation_changed"
  | "stale_target"
  | "request_changed";

/** JSON canonicalization for an exact API request, excluding only the grant reference header. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function executionGrantRequestHash(method: string, path: string, body: unknown, targetUpdatedAt?: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ method: method.toUpperCase(), path, body: canonicalize(body), targetUpdatedAt }))
    .digest("hex");
}


export function executionGrantDenial(
  grant: ExecutionGrant,
  attempt: ExecutionGrantAttempt,
): ExecutionGrantDenial | null {
  if (grant.companyId !== attempt.companyId) return "company_mismatch";
  if (grant.decision.kind === "agent" && grant.decision.approverAgentId === grant.proposerAgentId) {
    return "self_approval";
  }
  if (grant.decision.kind === "agent" && grant.decision.approverAgentId === grant.executorAgentId) {
    return "approver_is_executor";
  }
  if (grant.proposerAgentId === grant.executorAgentId) return "proposer_is_executor";
  if (grant.targetAgentId === attempt.decisionStewardAgentId) return "steward_powers";
  if (grant.consumedAt !== null) return "already_consumed";
  if (grant.expiresAt.getTime() <= attempt.now.getTime()) return "expired";
  if (grant.policyVersion !== attempt.currentPolicyVersion) return "policy_version_changed";
  if (grant.executorAgentId !== attempt.executorAgentId) return "unauthorized_executor";
  if (grant.targetAgentId !== attempt.targetAgentId) return "target_changed";
  if (grant.operation !== attempt.operation) return "operation_changed";
  if (grant.targetRevisionId !== attempt.targetRevisionId) return "stale_target";
  if (grant.requestHash !== attempt.requestHash) return "request_changed";
  return null;
}
