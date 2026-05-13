// Type definitions for the legal-layer configuration loaded from
// risk-gates/*.yaml and profiles/*.yaml. Kept narrow: only fields the
// risk-gate engine actually consumes are typed; arbitrary extra keys
// are allowed via index signatures so YAML editors can document intent
// without breaking parsing.

export interface RiskGateTrigger {
  artifact_kind?: string;
  action?: string;
  keyword_in_deliverable?: string[];
}

export interface RiskGateApproval {
  approver_resolved_from: string;
  auto_block_resolved_from?: string;
  approval_card_template?: string;
}

export interface RiskGateDefinition {
  gate: string;
  display_name: string;
  description?: string;
  triggers: RiskGateTrigger[];
  evidence_required?: string[];
  approval: RiskGateApproval;
  hard_blocks?: string[];
  audit_log?: string[];
}

export interface ProfileGateConfig {
  approver: string;
  auto_block: boolean;
  rationale?: string;
  exceptions?: string[];
  threshold_usd?: number;
}

export interface ProfileDefinition {
  profile: string;
  display_name: string;
  description?: string;
  practice_areas: string[];
  specialists_enabled: Record<string, string[]>;
  mcp_connectors: string[];
  required_secrets: string[];
  risk_gates: Record<string, ProfileGateConfig>;
  kpis?: string[];
  intake_required_fields?: string[];
  [key: string]: unknown;
}

export interface GateEvaluationContext {
  action?: string;
  artifactKind?: string;
  deliverableText?: string;
  matterId?: string;
  agentId?: string;
  costUsd?: number;
}

export interface GateFiring {
  gateKey: string;
  matchedTrigger: string;
  approverRole: string;
  autoBlock: boolean;
  rationale?: string;
  evidenceRequired: string[];
  approvalCardTemplate?: string;
  hardBlocks: string[];
}
