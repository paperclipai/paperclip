import { MODEL_PROFILE_KEYS, type ModelProfileKey } from "@paperclipai/shared";
import type { AdapterModelProfileDefinition } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";

type ModelProfileRequestSource = "issue_override" | "wake_context";
type AppliedModelProfileConfigSource = "agent_runtime" | "adapter_default";

export interface ModelProfileApplication {
  requested: ModelProfileKey | null;
  requestedBy: ModelProfileRequestSource | null;
  applied: ModelProfileKey | null;
  configSource: AppliedModelProfileConfigSource | null;
  fallbackReason: string | null;
  adapterConfig: Record<string, unknown> | null;
}

function readModelProfileKey(value: unknown): ModelProfileKey | null {
  return MODEL_PROFILE_KEYS.includes(value as ModelProfileKey)
    ? (value as ModelProfileKey)
    : null;
}

function readContextModelProfile(
  contextSnapshot: Record<string, unknown> | null | undefined,
): ModelProfileKey | null {
  return readModelProfileKey(contextSnapshot?.modelProfile);
}

export function normalizeModelProfileWakeContext(input: {
  contextSnapshot: Record<string, unknown>;
  payload: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const modelProfileFromPayload = readModelProfileKey(input.payload?.modelProfile);
  if (!readContextModelProfile(input.contextSnapshot) && modelProfileFromPayload) {
    input.contextSnapshot.modelProfile = modelProfileFromPayload;
  }
  return input.contextSnapshot;
}

function readAgentRuntimeModelProfile(
  runtimeConfig: unknown,
  key: ModelProfileKey,
): { enabled: boolean; adapterConfig: Record<string, unknown>; configured: boolean } {
  const modelProfiles = parseObject(parseObject(runtimeConfig).modelProfiles);
  const profile = parseObject(modelProfiles[key]);
  if (Object.keys(profile).length === 0) {
    return { enabled: true, adapterConfig: {}, configured: false };
  }

  return {
    enabled: profile.enabled !== false,
    adapterConfig: parseObject(profile.adapterConfig),
    configured: true,
  };
}

export function resolveModelProfileApplication(input: {
  adapterModelProfiles: AdapterModelProfileDefinition[];
  agentRuntimeConfig: unknown;
  issueModelProfile: ModelProfileKey | null | undefined;
  contextSnapshot: Record<string, unknown> | null | undefined;
  profileResolutionFallbackReason?: string | null;
}): ModelProfileApplication {
  const issueModelProfile = input.issueModelProfile ?? null;
  const contextModelProfile = readContextModelProfile(input.contextSnapshot);
  const requested = issueModelProfile ?? contextModelProfile;
  const requestedBy: ModelProfileRequestSource | null = issueModelProfile
    ? "issue_override"
    : contextModelProfile
      ? "wake_context"
      : null;

  if (!requested) {
    return {
      requested: null,
      requestedBy: null,
      applied: null,
      configSource: null,
      fallbackReason: null,
      adapterConfig: null,
    };
  }

  const adapterProfile = input.adapterModelProfiles.find((profile) => profile.key === requested) ?? null;
  if (!adapterProfile) {
    return {
      requested,
      requestedBy,
      applied: null,
      configSource: null,
      fallbackReason: input.profileResolutionFallbackReason ?? "adapter_profile_not_supported",
      adapterConfig: null,
    };
  }

  const runtimeProfile = readAgentRuntimeModelProfile(input.agentRuntimeConfig, requested);
  if (!runtimeProfile.enabled) {
    return {
      requested,
      requestedBy,
      applied: null,
      configSource: null,
      fallbackReason: "agent_runtime_profile_disabled",
      adapterConfig: null,
    };
  }

  return {
    requested,
    requestedBy,
    applied: requested,
    configSource: runtimeProfile.configured ? "agent_runtime" : "adapter_default",
    fallbackReason: null,
    adapterConfig: {
      ...parseObject(adapterProfile.adapterConfig),
      ...runtimeProfile.adapterConfig,
    },
  };
}

export function mergeModelProfileAdapterConfig(input: {
  baseConfig: Record<string, unknown>;
  modelProfile: ModelProfileApplication;
  issueAdapterConfig: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  return {
    ...input.baseConfig,
    ...(input.modelProfile.adapterConfig ?? {}),
    ...(input.issueAdapterConfig ?? {}),
  };
}

export function modelProfileRunMetadata(
  modelProfile: ModelProfileApplication,
): Record<string, unknown> | null {
  if (!modelProfile.requested) return null;
  return {
    requested: modelProfile.requested,
    requestedBy: modelProfile.requestedBy,
    applied: modelProfile.applied,
    configSource: modelProfile.configSource,
    fallbackReason: modelProfile.fallbackReason,
  };
}

export function mergeModelProfileRunMetadata(
  resultJson: Record<string, unknown> | null,
  modelProfile: ModelProfileApplication,
): Record<string, unknown> | null {
  const metadata = modelProfileRunMetadata(modelProfile);
  if (!metadata) return resultJson;
  return {
    ...(resultJson ?? {}),
    modelProfile: metadata,
  };
}
