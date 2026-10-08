import { resolveQualifiedAcpxProfile } from "../../vendor/paperclip-runner/index.js";
import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  PAPERCLIP_RUNNER_ACPX_PROFILES,
  resolvePaperclipRunnerPermissionMode,
  resolvePaperclipRunnerCursorMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";
import {
  codexLocalReasoningEffortsForModel,
  isCodexLocalKnownModel,
} from "@paperclipai/adapter-codex-local";
import {
  AGENTCORE_QUALIFIED_MODEL,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
} from "../provider-profile-qualification.js";
import { resolveAcpxQualification, type AcpxQualificationCandidate } from "./acpx-qualification.js";
import { compatibleCodexModel } from "./codex-model-fallback.js";

export const QUALIFIED_OPENCODE_RUNNER_VERSION = "1.18.34" as const;
export const DEFAULT_OPENCODE_RUNNER_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;
export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;

export const DEFAULT_ACPX_RUNNER_MODELS = {
  grok: "grok-4.7",
  claude: "claude-sonnet-5",
  // These profiles require explicit configuration. Admission belongs to the runner.
  codex: null,
  cursor: null,
} as const;

export type QualifiedPaperclipRunnerAcpxAgent =
  keyof typeof DEFAULT_ACPX_RUNNER_MODELS;
type AdmittedPaperclipRunnerAcpxAgent = QualifiedPaperclipRunnerAcpxAgent | AcpxQualificationCandidate;

export type PaperclipRunnerProviderProfile =
  | { provider: "openai_dot"; backend: "openai_dot_mcp"; model: null; dotBindingId: string }
  | {
      provider: "codex";
      backend: "codex_app_server";
      model: string | null;
    }
  | {
      provider: "opencode";
      backend: "opencode_server";
      model: string;
    }
  | {
      provider: "claude_managed";
      backend: "claude_managed_agents_api";
      managedProfileId: string;
      model: string | null;
      maxSessionListCostUsd: number | null;
    }
  | {
      provider: "aws_agentcore";
      backend: "aws_agentcore_harness_api";
      agentCoreProfileId: string;
      model: string | null;
      maxEstimatedSessionCostUsd: number | null;
    }
  | {
      provider: "acpx";
      backend: "acpx_runtime";
      model: string;
      acpxAgent: AdmittedPaperclipRunnerAcpxAgent;
    };

export type PaperclipRunnerNativeProviderInput =
  | { provider: "openai_dot"; model: null; dotBinding: import("../../vendor/paperclip-runner/index.js").DotBindingSnapshot }
  | {
      provider: "codex";
      model: string | null;
      codexApprovalPolicy: "never" | "on-request" | "untrusted";
      codexReasoningEffort?: string;
    }
  | {
      provider: "opencode";
      model: string;
      opencodePermissionMode: "allow" | "ask" | "deny";
    }
  | {
      provider: "claude_managed";
      model: string;
      managedProfile: {
        profileId: string;
        anthropicAgentId: string;
        agentVersion: string;
        environmentId: string;
        betaVersion: typeof CLAUDE_MANAGED_BETA_VERSION;
      };
      maxSessionListCostUsd: number;
    }
  | {
      provider: "aws_agentcore";
      model: string;
      agentCoreProfile: {
        profileId: string;
        region: string;
        accountId: string;
        harnessArn: string;
        harnessVersion: string;
        endpointArn: string;
        endpointQualifier: string;
        agentRuntimeArn: string;
        memoryArn: string;
        memoryId: string;
        invocationRoleArn: string;
        contextBucket: string;
        contextPrefix: string;
        contextKmsKeyArn: string;
        qualificationRevision: string;
        eventExpiryDays: 90;
      };
      maxEstimatedSessionCostUsd: number;
      invocationLimits: {
        maxIterations: number;
        maxOutputTokens: number;
        timeoutSeconds: number;
      };
    }
  | {
      provider: "acpx";
      model: string;
      acpxAgent: AdmittedPaperclipRunnerAcpxAgent;
      acpxPermissionMode: "approve-all" | "approve-paperclip" | "approve-reads" | "deny-all";
      acpxSessionMode?: "agent" | "plan" | "ask";
    };

export class PaperclipRunnerProviderProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaperclipRunnerProviderProfileError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Configuration can be saved before pairing; task admission requires a binding. */
export function validatePaperclipRunnerDotConfig(config: Record<string, unknown>, requireBinding = true): string | null {
  const bindingId = optionalString(config.dotBindingId);
  if ((requireBinding && !bindingId) || (bindingId && !/^[0-9a-f-]{36}$/i.test(bindingId))
      || config.allowUnmeteredProvider !== true || (config.lifecycleMode && config.lifecycleMode !== "per_turn")
      || optionalString(config.model)) {
    throw new PaperclipRunnerProviderProfileError("paperclip_runner_dot_config_invalid", "Dot requires per-turn lifecycle and explicit externally billed, unmetered-provider acknowledgement. Pair a binding before assigning work.");
  }
  return bindingId;
}

/** A task may change a local Runner model (and Codex effort), but not provider identity. */
export function projectPaperclipRunnerTaskConfig(
  backend: "codex_app_server" | "opencode_server",
  agentConfig: unknown,
  taskOverrides: unknown,
  managedModel?: string,
): Record<string, unknown> {
  const base = asRecord(agentConfig);
  const task = asRecord(taskOverrides);
  const config = { ...base };
  // The server resolves a connection's model namespace after task overrides.
  // Carry that model into durable input without allowing routing to change the harness.
  const model = optionalString(managedModel) ?? optionalString(task.model);
  const effortKey = backend === "codex_app_server"
    ? ["modelReasoningEffort", "reasoningEffort", "effort"].find((key) => key in task)
    : undefined;
  if (backend === "codex_app_server" && ((model !== null && model !== optionalString(base.model)) || effortKey !== undefined)) {
    delete config.modelReasoningEffort;
    delete config.reasoningEffort;
    delete config.effort;
  }
  if (model !== null) config.model = model;
  if (effortKey !== undefined) config.modelReasoningEffort = task[effortKey];
  return config;
}

function positiveNumberOrNull(
  value: unknown,
  code: string,
  message: string,
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PaperclipRunnerProviderProfileError(code, message);
  }
  return parsed;
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  code: string,
  label: string,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > maximum
  ) {
    throw new PaperclipRunnerProviderProfileError(
      code,
      `${label} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value;
}

function assertPermissionMode(
  provider: PaperclipRunnerProvider,
  config: Record<string, unknown>,
): void {
  const capability = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  if (!capability.configurable) return;
  const configured = config[capability.configKey];
  if (
    configured !== undefined
    && resolvePaperclipRunnerPermissionMode(provider, configured) !== configured
  ) {
    if (provider === "codex") {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_codex_permission_mode_unqualified",
        "Paperclip Runner currently supports Codex only with codexPermissionMode set to never. Update the agent configuration before starting a new native run.",
      );
    }
    throw new PaperclipRunnerProviderProfileError(
      "runner_permission_mode_invalid",
      `${capability.configKey} is not supported by ${provider}.`,
    );
  }
}

/**
 * Rebind a persisted Claude Managed run only to the still-qualified profile
 * and the profile's current company secret. The secret itself may rotate, but
 * the agent configuration must rotate its binding to the same profile-owned
 * secret before recovery can continue.
 */
export function assertManagedProfileRecoveryBinding(input: {
  adapterConfig: unknown;
  snapshot: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
  };
  stored: {
    id: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    apiKeySecretId: string;
  };
}): void {
  const { snapshot, stored } = input;
  if (
    snapshot.profileId !== stored.id
    || snapshot.anthropicAgentId !== stored.anthropicAgentId
    || snapshot.agentVersion !== stored.agentVersion
    || snapshot.environmentId !== stored.environmentId
    || snapshot.betaVersion !== stored.betaVersion
  ) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_claude_managed_recovery_identity_mismatch",
      "The persisted Claude Managed identity no longer matches its qualified profile.",
    );
  }
  const rawBinding = asRecord(asRecord(input.adapterConfig).env).ANTHROPIC_API_KEY;
  const boundSecretId = asRecord(rawBinding).secretId;
  if (boundSecretId !== stored.apiKeySecretId) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_claude_managed_recovery_secret_mismatch",
      "The persisted Claude Managed run is not bound to its profile's current API-key secret.",
    );
  }
}

/** Revalidate the operator's AWS profile revocation and immutable identity on recovery. */
export function assertAgentCoreProfileRecoveryBinding(input: {
  snapshot: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: number;
  };
  stored: {
    id: string;
    configuration: Record<string, unknown>;
  };
}): void {
  const { snapshot, stored } = input;
  const configuration = asRecord(stored.configuration);
  const fields = [
    "region",
    "accountId",
    "harnessArn",
    "harnessVersion",
    "endpointArn",
    "endpointQualifier",
    "agentRuntimeArn",
    "memoryArn",
    "memoryId",
    "invocationRoleArn",
    "contextBucket",
    "contextPrefix",
    "contextKmsKeyArn",
    "qualificationRevision",
    "eventExpiryDays",
  ] as const;
  if (
    snapshot.profileId !== stored.id
    || fields.some((field) => snapshot[field] !== configuration[field])
  ) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_aws_agentcore_recovery_identity_mismatch",
      "The persisted AWS AgentCore identity no longer matches its qualified profile.",
    );
  }
}

/**
 * Resolve the immutable provider identity used for a fresh Paperclip Runner
 * selection. The persisted adapterConfig is the authority; runtimeConfig is
 * deliberately not consulted so model-profile or migration metadata cannot
 * silently switch the harness selected for a run.
 */
export function resolvePaperclipRunnerProviderProfile(
  adapterConfig: unknown,
): PaperclipRunnerProviderProfile {
  const config = asRecord(adapterConfig);
  const candidate = config.provider ?? "codex";
  if (!isPaperclipRunnerProvider(candidate)) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_unsupported",
      "Paperclip Runner provider must be Codex, OpenCode, Claude Managed, AWS AgentCore, or ACPX.",
    );
  }

  if (candidate === "openai_dot") {
    const bindingId = validatePaperclipRunnerDotConfig(config)!;
    return { provider: "openai_dot", backend: "openai_dot_mcp", model: null, dotBindingId: bindingId };
  }
  assertPermissionMode(candidate, config);
  try {
    resolvePaperclipRunnerCursorMode(candidate, config.acpxAgent, config.acpxSessionMode);
  } catch (error) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_cursor_mode_invalid",
      error instanceof Error ? error.message : "Invalid Cursor session mode",
    );
  }
  const model = optionalString(config.model);
  if (candidate === "codex") {
    return {
      provider: "codex",
      backend: "codex_app_server",
      model,
    };
  }

  if (candidate === "opencode") {
    if (!model || !model.includes("/") || model.endsWith("/")) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_opencode_model_invalid",
        "Paperclip Runner OpenCode requires model in provider/model form.",
      );
    }
    return {
      provider: "opencode",
      backend: "opencode_server",
      model,
    };
  }

  if (candidate === "claude_managed") {
    const managedProfileId = optionalString(config.managedProfileId);
    if (!managedProfileId) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_profile_required",
        "Paperclip Runner Claude Managed requires a company managed-agent profile.",
      );
    }
    if (config.managedAgentsRetentionAcknowledged !== true) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_retention_required",
        "Paperclip Runner Claude Managed requires acknowledgement of stateful beta retention.",
      );
    }
    if (model !== null && model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_unqualified",
        `The Claude Managed profile requires exact model ${CLAUDE_MANAGED_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "claude_managed",
      backend: "claude_managed_agents_api",
      managedProfileId,
      model,
      maxSessionListCostUsd: positiveNumberOrNull(
        config.maxSessionListCostUsd,
        "paperclip_runner_claude_managed_spend_cap_invalid",
        "Paperclip Runner Claude Managed requires a positive session spend ceiling when overridden.",
      ),
    };
  }

  if (candidate === "aws_agentcore") {
    const agentCoreProfileId = optionalString(config.agentCoreProfileId);
    if (!agentCoreProfileId) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_profile_required",
        "Paperclip Runner AWS AgentCore requires a company remote-agent profile.",
      );
    }
    if (config.agentCoreRetentionAcknowledged !== true) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_retention_required",
        "Paperclip Runner AWS AgentCore requires acknowledgement of 90-day Memory retention.",
      );
    }
    if (model !== null && model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_model_unqualified",
        `The AWS AgentCore profile requires exact model ${AGENTCORE_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "aws_agentcore",
      backend: "aws_agentcore_harness_api",
      agentCoreProfileId,
      model,
      maxEstimatedSessionCostUsd: positiveNumberOrNull(
        config.maxEstimatedSessionCostUsd,
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "Paperclip Runner AWS AgentCore requires a positive estimated session spend ceiling when overridden.",
      ),
    };
  }

  const acpxAgent = config.acpxAgent ?? "claude";
  const pendingAcpxProfile = PAPERCLIP_RUNNER_ACPX_PROFILES.find(profile => profile.value === acpxAgent && !profile.qualified);
  if (pendingAcpxProfile) {
    if (!model) throw new PaperclipRunnerProviderProfileError("paperclip_runner_acpx_model_required", `${pendingAcpxProfile.label} requires an explicit model ID; there is no default model.`);
    // Qualification authority belongs to the isolated server operator. Never
    // read this allowlist from adapter config, credential refs, or run env.
    let qualification: AcpxQualificationCandidate | undefined;
    try {
      qualification = resolveAcpxQualification({ kind: "acpx", agent: pendingAcpxProfile.value, model }, process.env);
    } catch {
      throw new PaperclipRunnerProviderProfileError("paperclip_runner_acpx_qualification_invalid", "ACPX qualification requires an exact host-authorized candidate and model.");
    }
    if (qualification) {
      return { provider: "acpx", backend: "acpx_runtime", model, acpxAgent: qualification };
    }
    throw new PaperclipRunnerProviderProfileError("paperclip_runner_acpx_agent_unavailable", `${pendingAcpxProfile.label} is awaiting local and Daytona qualification. Its profile is not enabled for production runs.`);
  }
  if (acpxAgent === "cursor" && (!model || model === "auto")) {
    throw new PaperclipRunnerProviderProfileError("paperclip_runner_acpx_model_required", "Cursor requires an explicit model ID; there is no default model.");
  }
  if (acpxAgent !== "claude" && acpxAgent !== "codex" && acpxAgent !== "grok" && acpxAgent !== "cursor") {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_agent_unavailable",
      "Paperclip Runner ACPX requires a qualified agent profile.",
    );
  }
  const selectedModel = model || DEFAULT_ACPX_RUNNER_MODELS[acpxAgent] || "";
  try {
    resolveQualifiedAcpxProfile(acpxAgent, selectedModel);
  } catch (error) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_model_unqualified",
      error instanceof Error ? error.message : "Paperclip Runner ACPX requires an admitted model.",
    );
  }
  return {
    provider: "acpx",
    backend: "acpx_runtime",
    model: selectedModel,
    acpxAgent,
  };
}

/**
 * Project the operator-owned adapter configuration and a qualified stored
 * profile into the closed native execution descriptor. Editable adapter
 * configuration can select a stored profile, but it cannot replace that
 * profile's immutable remote resource identity.
 */
export function resolvePaperclipRunnerNativeProviderInput(input: {
  backend: PaperclipRunnerProviderProfile["backend"];
  adapterConfig: unknown;
  /** Verified image CLI version for a fresh remote Codex run only. */
  codexCliVersion?: string | null;
  dotBinding?: import("../../vendor/paperclip-runner/index.js").DotBindingSnapshot;
  managedProfile?: {
    id: string;
    profileKey: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: string;
    defaultModel: string;
    defaultMaxListCostCents: number;
  } | null;
  agentCoreProfile?: {
    id: string;
    profileKey: string;
    configuration: Record<string, unknown>;
  } | null;
}): PaperclipRunnerNativeProviderInput {
  const config = asRecord(input.adapterConfig);
  const profile = resolvePaperclipRunnerProviderProfile(config);
  if (profile.backend !== input.backend) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_provider_changed",
      "Paperclip Runner provider changed after this run selected its native backend.",
    );
  }
  if (profile.provider === "openai_dot") {
    if (!input.dotBinding || input.dotBinding.bindingId !== profile.dotBindingId) throw new PaperclipRunnerProviderProfileError("paperclip_runner_dot_binding_unavailable", "Dot binding must be resolved by the server after normal admission.");
    return { provider: "openai_dot", model: null, dotBinding: input.dotBinding };
  }
  if (profile.provider === "opencode") {
    return {
      provider: "opencode",
      model: profile.model,
      opencodePermissionMode: resolvePaperclipRunnerPermissionMode(
        "opencode",
        config.opencodePermissionMode,
      ) as "allow" | "ask" | "deny",
    };
  }
  if (profile.provider === "acpx") {
    return {
      provider: "acpx",
      model: profile.model,
      acpxAgent: profile.acpxAgent,
      ...(profile.acpxAgent === "cursor" ? {
        acpxSessionMode: resolvePaperclipRunnerCursorMode("acpx", "cursor", config.acpxSessionMode),
      } : {}),
      acpxPermissionMode: resolvePaperclipRunnerPermissionMode(
        "acpx",
        config.acpxPermissionMode,
      ) as "approve-all" | "approve-paperclip" | "approve-reads" | "deny-all",
    };
  }
  if (profile.provider === "claude_managed") {
    const stored = input.managedProfile;
    if (
      !stored
      || (
        profile.managedProfileId !== stored.id
        && profile.managedProfileId !== stored.profileKey
      )
    ) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_profile_mismatch",
        "The qualified Claude Managed profile does not match the adapter selection.",
      );
    }
    if (stored.betaVersion !== CLAUDE_MANAGED_BETA_VERSION) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_beta_unqualified",
        "The Claude Managed profile beta version is not qualified.",
      );
    }
    const model = profile.model ?? optionalString(stored.defaultModel);
    const maxSessionListCostUsd = profile.maxSessionListCostUsd
      ?? stored.defaultMaxListCostCents / 100;
    if (!model) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_invalid",
        "The Claude Managed profile requires a model.",
      );
    }
    if (model !== CLAUDE_MANAGED_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_model_unqualified",
        `The Claude Managed profile requires exact model ${CLAUDE_MANAGED_QUALIFIED_MODEL}.`,
      );
    }
    if (!Number.isFinite(maxSessionListCostUsd) || maxSessionListCostUsd <= 0) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_claude_managed_spend_cap_invalid",
        "The Claude Managed profile requires a positive session spend ceiling.",
      );
    }
    return {
      provider: "claude_managed",
      model,
      managedProfile: {
        profileId: stored.id,
        anthropicAgentId: stored.anthropicAgentId,
        agentVersion: stored.agentVersion,
        environmentId: stored.environmentId,
        betaVersion: CLAUDE_MANAGED_BETA_VERSION,
      },
      maxSessionListCostUsd,
    };
  }
  if (profile.provider === "aws_agentcore") {
    const stored = input.agentCoreProfile;
    if (
      !stored
      || (
        profile.agentCoreProfileId !== stored.id
        && profile.agentCoreProfileId !== stored.profileKey
      )
    ) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_profile_mismatch",
        "The qualified AWS AgentCore profile does not match the adapter selection.",
      );
    }
    const remote = asRecord(stored.configuration);
    const required = (key: string): string => {
      const value = optionalString(remote[key]);
      if (!value) {
        throw new PaperclipRunnerProviderProfileError(
          "paperclip_runner_aws_agentcore_profile_invalid",
          `The qualified AWS AgentCore profile is missing ${key}.`,
        );
      }
      return value;
    };
    if (remote.eventExpiryDays !== 90) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_retention_unqualified",
        "The qualified AWS AgentCore profile must retain Memory events for exactly 90 days.",
      );
    }
    const maxEstimatedSessionCostUsd = profile.maxEstimatedSessionCostUsd
      ?? positiveNumberOrNull(
        remote.defaultMaxEstimatedSessionCostUsd,
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "The AWS AgentCore profile requires a positive estimated session spend ceiling.",
      );
    if (maxEstimatedSessionCostUsd === null) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_spend_cap_invalid",
        "The AWS AgentCore profile requires a positive estimated session spend ceiling.",
      );
    }
    const model = profile.model ?? required("defaultModel");
    if (model !== AGENTCORE_QUALIFIED_MODEL) {
      throw new PaperclipRunnerProviderProfileError(
        "paperclip_runner_aws_agentcore_model_unqualified",
        `The AWS AgentCore profile requires exact model ${AGENTCORE_QUALIFIED_MODEL}.`,
      );
    }
    return {
      provider: "aws_agentcore",
      model,
      agentCoreProfile: {
        profileId: stored.id,
        region: required("region"),
        accountId: required("accountId"),
        harnessArn: required("harnessArn"),
        harnessVersion: required("harnessVersion"),
        endpointArn: required("endpointArn"),
        endpointQualifier: required("endpointQualifier"),
        agentRuntimeArn: required("agentRuntimeArn"),
        memoryArn: required("memoryArn"),
        memoryId: required("memoryId"),
        invocationRoleArn: required("invocationRoleArn"),
        contextBucket: required("contextBucket"),
        contextPrefix: required("contextPrefix"),
        contextKmsKeyArn: required("contextKmsKeyArn"),
        qualificationRevision: required("qualificationRevision"),
        eventExpiryDays: 90,
      },
      maxEstimatedSessionCostUsd,
      invocationLimits: {
        maxIterations: boundedPositiveInteger(
          config.maxIterations,
          8,
          8,
          "paperclip_runner_aws_agentcore_max_iterations_invalid",
          "AWS AgentCore maxIterations",
        ),
        maxOutputTokens: boundedPositiveInteger(
          config.maxOutputTokens,
          4_096,
          4_096,
          "paperclip_runner_aws_agentcore_max_output_tokens_invalid",
          "AWS AgentCore maxOutputTokens",
        ),
        timeoutSeconds: boundedPositiveInteger(
          config.timeoutSeconds,
          300,
          300,
          "paperclip_runner_aws_agentcore_timeout_invalid",
          "AWS AgentCore timeoutSeconds",
        ),
      },
    };
  }
  const effort = config.modelReasoningEffort ?? config.reasoningEffort ?? config.effort;
  const allowedEfforts = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (effort !== undefined && effort !== null && effort !== "" && (
    typeof effort !== "string" || !allowedEfforts.includes(effort)
    || (profile.model && isCodexLocalKnownModel(profile.model)
      && !codexLocalReasoningEffortsForModel(profile.model).includes(effort as "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"))
  )) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_codex_effort_invalid",
      "Paperclip Runner Codex reasoning effort is not supported for this model.",
    );
  }
  return {
    provider: "codex",
    model: compatibleCodexModel(profile.model, input.codexCliVersion ?? null),
    codexApprovalPolicy: resolvePaperclipRunnerPermissionMode(
      "codex",
      config.codexPermissionMode,
    ) as "never" | "on-request" | "untrusted",
    ...(typeof effort === "string" && effort ? { codexReasoningEffort: effort } : {}),
  };
}
