import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";
import {
  PaperclipRunnerProviderProfileError,
  resolvePaperclipRunnerProviderProfile,
  type PaperclipRunnerProviderProfile,
} from "./provider-profile.js";

/**
 * Public compatibility resolver version. This value is persisted by the
 * original heartbeat selection seam and must remain stable for existing runs
 * and downstream importers.
 */
export const NATIVE_RUNTIME_RESOLVER_VERSION = "paperclip-runner-v1" as const;

/** Resolver version for the richer native runtime profile used by runnerd. */
export const NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION = "phase6-v1" as const;

export type HeartbeatRuntimeResolution =
  | {
      kind: "legacy";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: "direct_adapter" | "persisted_legacy_selection";
    }
  | {
      kind: "native";
      resolverVersion: typeof NATIVE_RUNTIME_RESOLVER_VERSION;
      reason: "explicit_paperclip_runner" | "persisted_native_selection";
      provider: PaperclipRunnerProviderProfile["provider"];
    };

export type NativeRuntimeResolution =
  | {
      kind: "legacy";
      resolverVersion: typeof NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION;
      reason: string;
      authorityDecision?: NativeStatusDecision;
    }
  | {
      kind: "native";
      resolverVersion: typeof NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION;
      reason: "eligible_opt_in";
      profile: {
        mode: "native";
        backend: "codex_app_server" | "opencode_server" | "acpx_runtime";
        protocolVersion: 1;
      };
      authorityDecision: NativeStatusDecision;
    };

/**
 * Runner ingress follows the resolved runtime decision, not a second instance
 * flag. Persisted native runs therefore keep their transport during recovery
 * after the rollout flag is disabled, while legacy runs never gain ingress.
 */
export function isRunnerIngressAuthorized(
  resolution: NativeRuntimeResolution,
): boolean {
  return resolution.kind === "native";
}

export class NativeRunnerSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeRunnerSelectionError";
  }
}

export class NativeRuntimeEligibilityError extends NativeRunnerSelectionError {
  constructor(
    code: string,
    reason?: string,
  ) {
    super(code, reason ?? `Native runner profile is ineligible: ${code}`);
    this.name = "NativeRuntimeEligibilityError";
  }
}

function ineligible(
  code: string,
  reason: string,
): NativeRuntimeEligibilityError {
  return new NativeRuntimeEligibilityError(
    code,
    reason,
  );
}

export function resolveNativeRuntimeMode(input: {
  enabled: boolean;
  runtimeConfig: unknown;
  adapterConfig?: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  const runnerAdapterSelected = input.agent.adapterType === "paperclip_runner";
  // Fresh direct-adapter runs never enter the native control plane, even if an
  // obsolete runtimeConfig.nativeRunner value is still present. Persisted
  // native runs are handled by resolveHeartbeatNativeRuntimeMode above this
  // fresh-selection seam so they remain recoverable after rollout changes.
  if (!runnerAdapterSelected) {
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
      reason: "direct_adapter",
    };
  }
  if (!input.enabled) {
    throw ineligible(
      "paperclip_runner_rollout_disabled",
      "Paperclip Runner is experimental and disabled on this instance.",
    );
  }
  let runnerProfile: PaperclipRunnerProviderProfile;
  try {
    runnerProfile = resolvePaperclipRunnerProviderProfile(input.adapterConfig);
  } catch (error) {
    if (error instanceof PaperclipRunnerProviderProfileError) {
      throw ineligible(error.code, error.message);
    }
    throw error;
  }
  if (
    input.agent.adapterType !== "paperclip_runner"
    || input.agent.status !== "active" && input.agent.status !== "running"
  ) {
    throw ineligible(
      "paperclip_runner_agent_ineligible",
      "Paperclip Runner requires an active agent.",
    );
  }
  const allowedWorkModes = ["standard", "planning", "ask"];
  if (!input.issue || !allowedWorkModes.includes(input.issue.workMode)) {
    throw ineligible(
      "paperclip_runner_issue_ineligible",
      "Paperclip Runner requires a standard, planning, or ask task.",
    );
  }
  const rollout = resolveNativeMigrationStatus({
    facts: { applicationEnabled: true },
    priorIssueStatus: "in_progress",
    agentId: input.agent.id ?? "00000000-0000-4000-8000-000000000000",
  });
  if (!rollout.effects.some((effect) => effect.kind === "record_mode_native")) {
    throw ineligible(
      "paperclip_runner_rollout_policy_rejected",
      "Native rollout policy did not select native mode.",
    );
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
    reason: "eligible_opt_in",
    profile: {
      mode: "native",
      backend: runnerProfile.backend,
      protocolVersion: 1,
    },
    authorityDecision: rollout,
  };
}

/**
 * Backward-compatible heartbeat selection API. New runnerd code consumes the
 * richer profile from resolveHeartbeatNativeRuntimeMode; this public seam
 * keeps the original result shape, reason codes, and resolver version.
 */
export function resolveHeartbeatRuntimeMode(input: {
  persisted: {
    runtimeMode: string | null;
    runtimeModeResolvedAt: Date | null;
  };
  enabled: boolean;
  adapterType: string | null;
  adapterConfig: unknown;
  agentStatus: string;
  issue: { workMode: string } | null;
  executionTarget: { kind?: string } | null | undefined;
}): HeartbeatRuntimeResolution {
  if (input.persisted.runtimeModeResolvedAt) {
    if (input.persisted.runtimeMode === "native") {
      return {
        kind: "native",
        resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
        reason: "persisted_native_selection",
        provider: "codex",
      };
    }
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: "persisted_legacy_selection",
    };
  }

  let resolution: NativeRuntimeResolution;
  try {
    resolution = resolveNativeRuntimeMode({
      enabled: input.enabled,
      runtimeConfig: {},
      adapterConfig: input.adapterConfig,
      agent: {
        status: input.agentStatus,
        adapterType: input.adapterType,
      },
      issue: input.issue
        ? { id: "heartbeat-runtime-selection", workMode: input.issue.workMode }
        : null,
      target: input.executionTarget,
      workspaceId: null,
    });
  } catch (error) {
    if (error instanceof NativeRuntimeEligibilityError) {
      throw new NativeRunnerSelectionError(error.code, error.message);
    }
    throw error;
  }
  if (resolution.kind === "legacy") {
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: "direct_adapter",
    };
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
    reason: "explicit_paperclip_runner",
    provider: resolution.profile.backend === "opencode_server"
      ? "opencode"
      : resolution.profile.backend === "acpx_runtime"
        ? "acpx"
        : "codex",
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
    driverKind?: string | null;
  };
  enabled: boolean;
  runtimeConfig: unknown;
  adapterConfig?: unknown;
  agent: { id?: string; status: string; adapterType: string | null };
  issue: { id: string; workMode: string; executionWorkspaceId?: string | null } | null;
  target: { kind?: string } | null | undefined;
  workspaceId: string | null;
}): NativeRuntimeResolution {
  if (input.persisted.runtimeModeResolvedAt) {
    if (input.persisted.runtimeMode === "native") {
      if (input.agent.adapterType !== "paperclip_runner") {
        throw ineligible(
          "paperclip_runner_adapter_binding_mismatch",
          "A persisted native run must remain bound to the Paperclip Runner adapter.",
        );
      }
      if (
        input.agent.status !== "active" &&
        input.agent.status !== "running"
      ) {
        throw ineligible(
          "paperclip_runner_agent_ineligible",
          "A persisted Paperclip Runner run cannot recover through a non-invokable agent.",
        );
      }
      const driverKind = input.persisted.driverKind;
      const backend = driverKind === "opencode_server"
        ? "opencode_server"
        : driverKind === "acpx_runtime"
          ? "acpx_runtime"
          : driverKind === null
              || driverKind === undefined
              || driverKind === "codex"
              || driverKind === "codex_app_server"
            ? "codex_app_server"
            : null;
      if (backend === null) {
        throw ineligible(
          "paperclip_runner_driver_unsupported",
          `Persisted Paperclip Runner driver is unsupported: ${driverKind}`,
        );
      }
      return {
        kind: "native",
        resolverVersion: NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
        reason: "eligible_opt_in",
        profile: {
          mode: "native",
          backend,
          protocolVersion: 1,
        },
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
      resolverVersion: NATIVE_RUNTIME_PROFILE_RESOLVER_VERSION,
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
