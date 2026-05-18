import { z } from "zod";

// LET-412: `buildCapabilityApplyPlan` (and its node:crypto import) lives in
// ./capability-apply-plan.ts so that this barrel can be safely consumed by
// the UI bundle, which only depends on the schemas/types/constants below.

// ── Risk classes ──────────────────────────────────────────────────────────────

export const CAPABILITY_APPLY_RISK_CLASSES = [
  "internal_safe",
  "external_readonly",
  "external_write",
  "destructive_or_spend",
  "governance_critical",
] as const;

export type CapabilityApplyRiskClass = (typeof CAPABILITY_APPLY_RISK_CLASSES)[number];

export const capabilityApplyRiskClassSchema = z.enum(CAPABILITY_APPLY_RISK_CLASSES);

// ── Plan states ───────────────────────────────────────────────────────────────

export const CAPABILITY_APPLY_PLAN_STATES = [
  "pending",
  "approval_requested",
  "approved",
  "executing",
  "applied",
  "cancelled",
  "declined",
  "expired",
  "partially_applied",
] as const;

export type CapabilityApplyPlanState = (typeof CAPABILITY_APPLY_PLAN_STATES)[number];

// ── Step states ───────────────────────────────────────────────────────────────

export const CAPABILITY_APPLY_STEP_STATES = [
  "pending",
  "executing",
  "completed",
  "failed",
  "skipped",
] as const;

export type CapabilityApplyStepState = (typeof CAPABILITY_APPLY_STEP_STATES)[number];

// ── Step kinds ────────────────────────────────────────────────────────────────

export const CAPABILITY_APPLY_STEP_KINDS = [
  "add_mcp_server",
  "remove_mcp_server",
  "update_mcp_server",
  "add_skill_ref",
  "remove_skill_ref",
  "add_tool_ref",
  "remove_tool_ref",
] as const;

export type CapabilityApplyStepKind = (typeof CAPABILITY_APPLY_STEP_KINDS)[number];

// ── Stable error codes ────────────────────────────────────────────────────────

export const CAPABILITY_APPLY_ERROR_CODES = {
  PLAN_HASH_MISMATCH: "capability_apply_plan_hash_mismatch",
  APPROVAL_NOT_ACCEPTED: "capability_apply_approval_not_accepted",
  APPROVAL_CONSUMED: "capability_apply_approval_consumed",
  STEP_REQUIRES_GOVERNANCE: "capability_apply_step_requires_separate_governance_workflow",
  LIVE_EXECUTION_DISABLED: "capability_apply_live_execution_disabled",
  OPTIMISTIC_CONFLICT: "capability_apply_optimistic_conflict",
  SECRET_SHAPED_IDENTIFIER: "capability_apply_secret_shaped_identifier_rejected",
  CATALOG_NOT_ALLOWLISTED: "capability_apply_catalog_not_allowlisted",
  EGRESS_BLOCKED: "capability_apply_egress_blocked",
  NAMED_SECRET_NOT_FOUND: "capability_apply_named_secret_not_found",
} as const;

export type CapabilityApplyErrorCode = (typeof CAPABILITY_APPLY_ERROR_CODES)[keyof typeof CAPABILITY_APPLY_ERROR_CODES];

// ── Step target ref ───────────────────────────────────────────────────────────

export const capabilityApplyStepTargetRefSchema = z.object({
  catalogId: z.string().optional(),
  label: z.string().min(1).max(240),
  transport: z.enum(["stdio", "sse", "streamable_http"]).optional(),
  /**
   * Optional remote endpoint reference for MCP servers that use a remote
   * transport (sse / streamable_http). Carried end-to-end so the LET-402
   * SSRF/egress guard can reject loopback/private/IMDS targets at execute
   * time. Never holds a secret value — only a public-shaped URL the catalog
   * resolver returned; secret material is referenced separately via
   * `namedSecretRefs`.
   */
  remoteUrl: z.string().max(2048).optional(),
  namedSecretRefs: z.array(z.string()).default([]),
});

export type CapabilityApplyStepTargetRef = z.infer<typeof capabilityApplyStepTargetRefSchema>;

// ── Plan step ─────────────────────────────────────────────────────────────────

export interface CapabilityApplyStep {
  stepId: string;
  ordinal: number;
  kind: CapabilityApplyStepKind;
  target: CapabilityApplyStepTargetRef;
  riskClass: CapabilityApplyRiskClass;
  annotations: {
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    readOnlyHint?: boolean;
  };
  sideEffects: string[];
  secretSummary: string[];
  state: CapabilityApplyStepState;
}

// ── Approval payload (server-built, per LET-353 §2.2) ─────────────────────────

export interface CapabilityApplyScopeSummary {
  agentId: string;
  agentLabel: string;
  totalSteps: number;
  stepsByRiskClass: Record<CapabilityApplyRiskClass, number>;
  totalNamedSecretRefs: number;
  hasGovernanceCritical: false;
}

export interface CapabilityApplySecretSummary {
  namedSecretRefs: string[];
  count: number;
  containsValues: false;
}

export interface CapabilityApplyApprovalPayload {
  version: 1;
  planRevisionId: string;
  dryRunHash: string;
  agentId: string;
  scopeSummary: CapabilityApplyScopeSummary;
  steps: Array<{
    stepId: string;
    kind: CapabilityApplyStepKind;
    target: { catalogId?: string; label: string };
    riskClass: CapabilityApplyRiskClass;
    annotations: Record<string, boolean>;
    sideEffects: string[];
    secretSummary: CapabilityApplySecretSummary;
  }>;
  liveExecutionFlagState: "off";
  noLiveActionAttestation: true;
}

// ── Plan summary (redacted, returned from GET /plans/:id) ────────────────────

export interface CapabilityApplyPlanSummary {
  id: string;
  companyId: string;
  agentId: string;
  dryRunHash: string;
  state: CapabilityApplyPlanState;
  steps: CapabilityApplyStep[];
  approvalId: string | null;
  optimisticVersion: number;
  createdAt: string;
  updatedAt: string;
}

// ── Event ─────────────────────────────────────────────────────────────────────

export interface CapabilityApplyEvent {
  id: string;
  planId: string;
  stepId: string | null;
  companyId: string;
  actorUserId: string | null;
  actorAgentId: string | null;
  runId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Plan builder ──────────────────────────────────────────────────────────────

export interface CapabilityApplyPlanInput {
  companyId: string;
  agentId: string;
  /** The effective delta output from LET-140-F apply-preview */
  effectiveDelta: {
    mcpServerChanges?: Array<{
      kind: "add" | "remove" | "update";
      serverId: string;
      displayName: string;
      catalogId?: string;
      transport?: string;
      remoteUrl?: string;
      riskClass?: string;
      changedFields?: string[];
      requiredSecretNames?: string[];
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
    }>;
    skillRefChanges?: Array<{ kind: "add" | "remove"; ref: string }>;
    toolRefChanges?: Array<{ kind: "add" | "remove"; ref: string }>;
  };
  proposalIdentity?: string;
}

export interface CapabilityApplyPlanBuilderResult {
  dryRunHash: string;
  steps: CapabilityApplyStep[];
  hasGovernanceCritical: boolean;
  governanceCriticalStepKinds: CapabilityApplyStepKind[];
}

// `buildCapabilityApplyPlan` lives in ./capability-apply-plan.ts (see LET-412).
