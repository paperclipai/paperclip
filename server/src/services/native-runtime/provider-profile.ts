import {
  isPaperclipRunnerProvider,
  PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES,
  resolvePaperclipRunnerPermissionMode,
  type PaperclipRunnerProvider,
} from "@paperclipai/adapter-utils";
import {
  AGENTCORE_QUALIFIED_MODEL,
  CLAUDE_MANAGED_QUALIFIED_MODEL,
} from "../provider-profile-qualification.js";

export const QUALIFIED_OPENCODE_RUNNER_VERSION = "1.18.17" as const;
export const DEFAULT_OPENCODE_RUNNER_MODEL =
  "openrouter/deepseek/deepseek-v4-flash-0731" as const;
export const CLAUDE_MANAGED_BETA_VERSION = "managed-agents-2026-04-01" as const;

export const QUALIFIED_ACPX_RUNNER_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
} as const;

export type QualifiedPaperclipRunnerAcpxAgent =
  keyof typeof QUALIFIED_ACPX_RUNNER_MODELS;

export type PaperclipRunnerProviderProfile =
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
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
    };

export type PaperclipRunnerNativeProviderInput =
  | {
      provider: "codex";
      model: string | null;
      codexApprovalPolicy: "never" | "on-request" | "untrusted";
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
      acpxAgent: QualifiedPaperclipRunnerAcpxAgent;
      acpxPermissionMode: "approve-all" | "approve-reads" | "deny-all";
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

  assertPermissionMode(candidate, config);
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

  const acpxAgent = config.acpxAgent;
  if (acpxAgent !== "claude" && acpxAgent !== "codex") {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_agent_unavailable",
      "Paperclip Runner ACPX requires the qualified Claude or Codex agent profile; Pi is not available.",
    );
  }
  const qualifiedModel = QUALIFIED_ACPX_RUNNER_MODELS[acpxAgent];
  if (model !== qualifiedModel) {
    throw new PaperclipRunnerProviderProfileError(
      "paperclip_runner_acpx_model_unqualified",
      `Paperclip Runner ACPX ${acpxAgent} requires exact model ${qualifiedModel}.`,
    );
  }
  return {
    provider: "acpx",
    backend: "acpx_runtime",
    model,
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
      acpxPermissionMode: resolvePaperclipRunnerPermissionMode(
        "acpx",
        config.acpxPermissionMode,
      ) as "approve-all" | "approve-reads" | "deny-all",
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
  return {
    provider: "codex",
    model: profile.model,
    codexApprovalPolicy: resolvePaperclipRunnerPermissionMode(
      "codex",
      config.codexPermissionMode,
    ) as "never" | "on-request" | "untrusted",
  };
}
