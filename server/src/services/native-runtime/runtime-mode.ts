import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";

export const NATIVE_RUNTIME_RESOLVER_VERSION = "phase6-v1" as const;

export type NativeRuntimeResolution =
  | {
      kind: "legacy";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: string;
      authorityDecision?: NativeStatusDecision;
    }
  | {
      kind: "native";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: "eligible_opt_in";
      profile: { mode: "native"; backend: "codex_app_server"; protocolVersion: 1 };
      authorityDecision: NativeStatusDecision;
    };

export class NativeRuntimeEligibilityError extends Error {
  readonly code = "native_runtime_ineligible" as const;
  constructor(reason: string) {
    super(`Native runner profile is ineligible: ${reason}`);
    this.name = "NativeRuntimeEligibilityError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveNativeRuntimeMode(input: {
  enabled: boolean;
  runtimeConfig: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  const nativeRunner = record(record(input.runtimeConfig).nativeRunner);
  const mode = nativeRunner.mode;
  if (!input.enabled) {
    const compatibility = resolveNativeCompatibilityStatus({
      facts: { shadowApplicationDisabled: true },
      priorIssueStatus: "in_progress",
      agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
    });
    if (!compatibility.effects.some((effect) => effect.kind === "record_shadow_decision")) {
      throw new NativeRuntimeEligibilityError("disabled native application must remain shadow-only");
    }
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: "instance_flag_disabled",
      authorityDecision: compatibility,
    };
  }
  if (mode === undefined || mode === "legacy") {
    return { kind: "legacy", resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION, reason: "agent_not_opted_in" };
  }
  if (mode !== "native") throw new NativeRuntimeEligibilityError("unsupported profile mode");
  if (nativeRunner.backend !== "codex_app_server" || nativeRunner.protocolVersion !== 1) {
    throw new NativeRuntimeEligibilityError("unsupported backend or protocol version");
  }
  if (input.agent.adapterType !== "codex_local" || input.agent.status !== "active" && input.agent.status !== "running") {
    throw new NativeRuntimeEligibilityError("agent must be an active codex_local agent");
  }
  if (!input.issue || input.issue.workMode !== "standard") {
    throw new NativeRuntimeEligibilityError("run must be bound to a standard issue");
  }
  if (!input.workspaceId || input.target?.kind && input.target.kind !== "local") {
    throw new NativeRuntimeEligibilityError("a realized local workspace is required");
  }
  const rollout = resolveNativeMigrationStatus({
    facts: { applicationEnabled: true },
    priorIssueStatus: "in_progress",
    agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
  });
  if (!rollout.effects.some((effect) => effect.kind === "record_mode_native")) {
    throw new NativeRuntimeEligibilityError("native rollout policy did not select native mode");
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
    reason: "eligible_opt_in",
    profile: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
    authorityDecision: rollout,
  };
}

/**
 * Production heartbeat selection seam. A resolved run keeps its persisted
 * mode across configuration changes; only a fresh unresolved run consults the
 * current global flag and agent profile.
 */
export function resolveHeartbeatNativeRuntimeMode(input: {
  persisted: {
    runtimeMode: string | null;
    runtimeModeReason: string | null;
    runtimeModeResolvedAt: Date | null;
  };
  enabled: boolean;
  runtimeConfig: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  if (input.persisted.runtimeModeResolvedAt) {
    if (input.persisted.runtimeMode === "native") {
      return {
        kind: "native",
        resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
        reason: "eligible_opt_in",
        profile: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
        authorityDecision: resolveNativeMigrationStatus({
          facts: input.enabled
            ? { applicationEnabled: true }
            : { killSwitchActiveForNewRuns: true },
          priorIssueStatus: "in_progress",
          agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
        }),
      };
    }
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: input.persisted.runtimeModeReason ?? "persisted_legacy_selection",
    };
  }
  return resolveNativeRuntimeMode(input);
}

/** Production read-model facts used by compatibility and mixed-ledger views. */
export function inspectNativeCompatibilityState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatus: string;
  statusVersion: number;
  persistedEffectKinds: string[];
}) {
  const effects = input.persistedEffectKinds.length > 0
    ? [...input.persistedEffectKinds]
    : input.resolution.kind === "legacy"
      ? ["legacy_existing_behavior"]
      : input.nativeRecordCount === 0 && input.statusVersion === 0
        ? ["initialize_status_version_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasNativeDecisionLineage: input.decisionCount > 0,
    issueStatus: input.issueStatus,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer" : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

/** Expand-only migration evidence; it never mutates or synthesizes history. */
export function inspectNativeMigrationState(input: {
  resolution: NativeRuntimeResolution;
  nativeRecordCount: number;
  decisionCount: number;
  issueStatusBefore: string;
  issueStatusAfter: string;
  statusVersion: number;
  hasPendingReview: boolean;
}) {
  const effects = input.resolution.kind === "legacy"
    ? input.issueStatusBefore === "done"
      ? ["retain_legacy_mode", "retain_audit_lineage"]
      : ["return_native_false"]
    : input.nativeRecordCount === 0 && input.hasPendingReview && input.statusVersion > 0
      ? ["increment_status_version_once", "bind_reviewer"]
      : input.nativeRecordCount === 0
        ? ["expand_schema", "status_version_default_zero"]
        : [];
  return {
    mode: input.resolution.kind,
    native: input.nativeRecordCount > 0,
    hasSyntheticHistory: input.nativeRecordCount === 0 && input.decisionCount > 0,
    statusPreserved: input.issueStatusBefore === input.issueStatusAfter,
    statusVersion: input.statusVersion,
    statusAction: input.resolution.kind === "legacy" ? "legacy_finalizer"
      : input.hasPendingReview ? input.issueStatusAfter : "preserve",
    reasonCode: null,
    effects,
  } as const;
}

export type NativeCompatibilityFacts = {
  invalidNativeFinalization?: boolean;
  terminalResumeAuthorized?: boolean;
  shadowApplicationDisabled?: boolean;
  mixedLedger?: boolean;
  statusWriterAdvancedVersion?: boolean;
};

export function resolveNativeCompatibilityStatus(input: {
  facts: NativeCompatibilityFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  if (input.facts.invalidNativeFinalization) {
    return preserve("native_finalization_invalid", [{
      kind: "record_finalization_error",
      cause: "native_finalization_invalid",
      nextAction: "Repair the persisted native result.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.terminalResumeAuthorized) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "authorized_resume",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: "same_agent",
        summary: "Resume the terminal issue through the authorized compatibility path.",
        idempotencyKey: "native-compatibility:authorized-resume",
        agentId: input.agentId,
      }],
    };
  }
  if (input.facts.shadowApplicationDisabled) {
    return preserve("completion_contract_satisfied", [{ kind: "record_shadow_decision" }]);
  }
  if (input.facts.mixedLedger) {
    return preserve("completion_contract_satisfied", [{ kind: "render_four_layers" }]);
  }
  if (input.facts.statusWriterAdvancedVersion) {
    return preserve("arbitration_conflict_reloaded", [
      { kind: "increment_status_version" },
      { kind: "schedule_reconciliation" },
    ]);
  }
  throw new Error("native_compatibility_facts_invalid");
}

export type NativeMigrationFacts = {
  shadowMaterialization?: boolean;
  classifiedDivergence?: boolean;
  applicationEnabled?: boolean;
  policyPinned?: boolean;
  killSwitchActiveForNewRuns?: boolean;
};

export function resolveNativeMigrationStatus(input: {
  facts: NativeMigrationFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  if (input.facts.shadowMaterialization) {
    return preserve("completion_contract_satisfied", [
      { kind: "materialize_contract" },
      { kind: "record_shadow_decision" },
    ]);
  }
  if (input.facts.classifiedDivergence) {
    return preserve("completion_evidence_incomplete", [{ kind: "record_mode_labeled_divergence" }]);
  }
  if (input.facts.killSwitchActiveForNewRuns) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [
        {
          kind: "enqueue_continuation",
          continuationKind: "same_agent",
          summary: "Finish the already-active run in native mode.",
          idempotencyKey: "native-migration:kill-switch-active-run",
          agentId: input.agentId,
        },
        { kind: "finish_as_native" },
      ],
    };
  }
  if (input.facts.policyPinned) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "record_mode_native" }, { kind: "record_policy_version" }],
    };
  }
  if (input.facts.applicationEnabled) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [
        {
          kind: "enqueue_continuation",
          continuationKind: "same_agent",
          summary: "Continue the allowlisted native run.",
          idempotencyKey: "native-migration:application-enabled",
          agentId: input.agentId,
        },
        { kind: "record_mode_native" },
      ],
    };
  }
  throw new Error("native_migration_facts_invalid");
}
