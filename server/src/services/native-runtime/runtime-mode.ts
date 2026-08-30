export const NATIVE_RUNTIME_RESOLVER_VERSION = "paperclip-runner-v1" as const;

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
      provider: "codex";
    };

export class NativeRunnerSelectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeRunnerSelectionError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Resolve a run once. Persisted selections do not consult a later flag change. */
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

  if (input.adapterType !== "paperclip_runner") {
    return {
      kind: "legacy",
      resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
      reason: "direct_adapter",
    };
  }
  if (!input.enabled) {
    throw new NativeRunnerSelectionError(
      "paperclip_runner_rollout_disabled",
      "Paperclip Runner is experimental and disabled on this instance.",
    );
  }
  const provider = record(input.adapterConfig).provider ?? "codex";
  if (provider !== "codex") {
    throw new NativeRunnerSelectionError(
      "paperclip_runner_provider_unsupported",
      "Paperclip Runner currently supports only the Codex provider.",
    );
  }
  if (!input.issue || !["standard", "planning", "ask"].includes(input.issue.workMode)) {
    throw new NativeRunnerSelectionError(
      "paperclip_runner_issue_ineligible",
      "Paperclip Runner requires a standard, planning, or ask task.",
    );
  }
  if (!input.executionTarget || input.executionTarget.kind !== "local") {
    throw new NativeRunnerSelectionError(
      "paperclip_runner_environment_unsupported",
      "Paperclip Runner currently requires a local execution environment.",
    );
  }
  if (!["active", "running"].includes(input.agentStatus)) {
    throw new NativeRunnerSelectionError(
      "paperclip_runner_agent_ineligible",
      "Paperclip Runner requires an active agent.",
    );
  }
  return {
    kind: "native",
    resolverVersion: NATIVE_RUNTIME_RESOLVER_VERSION,
    reason: "explicit_paperclip_runner",
    provider: "codex",
  };
}
