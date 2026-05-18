import { createHash } from "node:crypto";
import type {
  CapabilityApplyPlanInput,
  CapabilityApplyPlanBuilderResult,
  CapabilityApplyStep,
  CapabilityApplyStepKind,
  CapabilityApplyRiskClass,
} from "./capability-apply.js";

// LET-412: kept in a server-only module so the @paperclipai/shared barrel
// stays browser-bundleable. node:crypto cannot be imported from the UI build
// (Vite externalizes it and Rollup then fails on `createHash` usage), so any
// runtime that needs the canonical plan builder must import it from the
// server context.

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
        remoteUrl: c.remoteUrl ?? null,
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
        remoteUrl: change.remoteUrl,
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
