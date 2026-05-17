import { z } from "zod";
import { createHash } from "node:crypto";

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
} as const;

export type CapabilityApplyErrorCode = (typeof CAPABILITY_APPLY_ERROR_CODES)[keyof typeof CAPABILITY_APPLY_ERROR_CODES];

// ── Step target ref ───────────────────────────────────────────────────────────

export const capabilityApplyStepTargetRefSchema = z.object({
  catalogId: z.string().optional(),
  label: z.string().min(1).max(240),
  transport: z.enum(["stdio", "sse", "streamable_http"]).optional(),
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

// ── Approval payload (server-built, per §2.2) ─────────────────────────────────

export interface CapabilityApplyApprovalPayload {
  version: 1;
  planRevisionId: string;
  dryRunHash: string;
  agentId: string;
  scopeSummary: string;
  steps: Array<{
    stepId: string;
    kind: CapabilityApplyStepKind;
    target: { catalogId?: string; label: string };
    riskClass: CapabilityApplyRiskClass;
    annotations: Record<string, boolean>;
    sideEffects: string[];
    secretSummary: string[];
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

function canonicalizeEffectiveDelta(delta: CapabilityApplyPlanInput["effectiveDelta"]): string {
  const canonical = {
    mcpServerChanges: (delta.mcpServerChanges ?? [])
      .map((c) => ({
        catalogId: c.catalogId ?? null,
        changedFields: (c.changedFields ?? []).slice().sort(),
        destructiveHint: c.destructiveHint ?? false,
        displayName: c.displayName,
        kind: c.kind,
        openWorldHint: c.openWorldHint ?? false,
        readOnlyHint: c.readOnlyHint ?? false,
        requiredSecretNames: (c.requiredSecretNames ?? []).slice().sort(),
        riskClass: c.riskClass ?? "external_write",
        serverId: c.serverId,
        transport: c.transport ?? "stdio",
      }))
      .sort((a, b) => a.serverId.localeCompare(b.serverId)),
    skillRefChanges: (delta.skillRefChanges ?? [])
      .slice()
      .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
    toolRefChanges: (delta.toolRefChanges ?? [])
      .slice()
      .sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
  };
  return JSON.stringify(canonical);
}

function mapRiskClass(c: {
  riskClass?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  kind: "add" | "remove" | "update";
}): CapabilityApplyRiskClass {
  if (c.riskClass === "governance_critical") return "governance_critical";
  if (c.kind === "remove") return "internal_safe";
  if (c.destructiveHint) return "destructive_or_spend";
  if (c.readOnlyHint && !c.openWorldHint) return "external_readonly";
  return "external_write";
}

export function buildCapabilityApplyPlan(input: CapabilityApplyPlanInput): CapabilityApplyPlanBuilderResult {
  const canonicalized = canonicalizeEffectiveDelta(input.effectiveDelta);
  const dryRunHash = createHash("sha256").update(canonicalized).digest("hex").slice(0, 32);

  const steps: CapabilityApplyStep[] = [];
  let ordinal = 0;
  const governanceCriticalKinds: CapabilityApplyStepKind[] = [];

  for (const change of input.effectiveDelta.mcpServerChanges ?? []) {
    const kind: CapabilityApplyStepKind =
      change.kind === "add"
        ? "add_mcp_server"
        : change.kind === "remove"
          ? "remove_mcp_server"
          : "update_mcp_server";

    const riskClass = mapRiskClass(change);

    if (riskClass === "governance_critical") {
      governanceCriticalKinds.push(kind);
    }

    steps.push({
      stepId: `step-${ordinal}`,
      ordinal: ordinal++,
      kind,
      target: {
        catalogId: change.catalogId,
        label: change.displayName,
        transport: change.transport as "stdio" | "sse" | "streamable_http" | undefined,
        namedSecretRefs: change.requiredSecretNames ?? [],
      },
      riskClass,
      annotations: {
        destructiveHint: change.destructiveHint,
        openWorldHint: change.openWorldHint,
        readOnlyHint: change.readOnlyHint,
      },
      sideEffects: [],
      secretSummary: (change.requiredSecretNames ?? []).map((n) => `named:${n}`),
      state: "pending",
    });
  }

  for (const change of input.effectiveDelta.skillRefChanges ?? []) {
    const kind: CapabilityApplyStepKind = change.kind === "add" ? "add_skill_ref" : "remove_skill_ref";
    steps.push({
      stepId: `step-${ordinal}`,
      ordinal: ordinal++,
      kind,
      target: { label: change.ref, namedSecretRefs: [] },
      riskClass: "internal_safe",
      annotations: {},
      sideEffects: [],
      secretSummary: [],
      state: "pending",
    });
  }

  for (const change of input.effectiveDelta.toolRefChanges ?? []) {
    const kind: CapabilityApplyStepKind = change.kind === "add" ? "add_tool_ref" : "remove_tool_ref";
    steps.push({
      stepId: `step-${ordinal}`,
      ordinal: ordinal++,
      kind,
      target: { label: change.ref, namedSecretRefs: [] },
      riskClass: "internal_safe",
      annotations: {},
      sideEffects: [],
      secretSummary: [],
      state: "pending",
    });
  }

  return {
    dryRunHash,
    steps,
    hasGovernanceCritical: governanceCriticalKinds.length > 0,
    governanceCriticalStepKinds: governanceCriticalKinds,
  };
}
