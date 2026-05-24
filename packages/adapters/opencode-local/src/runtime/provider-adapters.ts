import { inferOpenAiCompatibleBiller } from "@paperclipai/adapter-utils";

export const OPENCODE_RUNTIME_CONTRACT_VERSION = "agentos-agents/v1";

export type OpenCodeProviderCapability =
  | "model_discovery"
  | "session_resume"
  | "reasoning_variants"
  | "usage_accounting";

export type OpenCodeProviderDescriptor = {
  id: string;
  aliases: string[];
  capabilities: OpenCodeProviderCapability[];
};

export type ResolvedOpenCodeProvider = {
  modelId: string | null;
  provider: string | null;
  biller: string;
  capabilities: OpenCodeProviderCapability[];
  contractVersion: string;
};

const BASE_CAPABILITIES: OpenCodeProviderCapability[] = [
  "model_discovery",
  "session_resume",
  "usage_accounting",
];

const PROVIDER_REGISTRY: OpenCodeProviderDescriptor[] = [
  {
    id: "azure",
    aliases: ["azure"],
    capabilities: [...BASE_CAPABILITIES, "reasoning_variants"],
  },
  {
    id: "openai",
    aliases: ["openai", "oai"],
    capabilities: [...BASE_CAPABILITIES, "reasoning_variants"],
  },
  {
    id: "anthropic",
    aliases: ["anthropic", "claude"],
    capabilities: BASE_CAPABILITIES,
  },
  {
    id: "gemini",
    aliases: ["gemini", "google"],
    capabilities: [...BASE_CAPABILITIES, "reasoning_variants"],
  },
  {
    id: "grok",
    aliases: ["grok", "xai"],
    capabilities: [...BASE_CAPABILITIES, "reasoning_variants"],
  },
  {
    id: "bedrock",
    aliases: ["bedrock", "aws"],
    capabilities: BASE_CAPABILITIES,
  },
];

const providerAliasToId = new Map<string, string>();
for (const provider of PROVIDER_REGISTRY) {
  for (const alias of provider.aliases) {
    providerAliasToId.set(alias.toLowerCase(), provider.id);
  }
}

function normalizeProviderId(input: string): string {
  const normalized = input.trim().toLowerCase();
  return providerAliasToId.get(normalized) ?? normalized;
}

export function parseProviderModelId(model: string | null | undefined): {
  provider: string;
  model: string;
} | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
  const provider = normalizeProviderId(trimmed.slice(0, slashIndex));
  const modelName = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !modelName) return null;
  return { provider, model: modelName };
}

export function normalizeProviderModelId(model: string | null | undefined): string | null {
  const parsed = parseProviderModelId(model);
  if (!parsed) return null;
  return `${parsed.provider}/${parsed.model}`;
}

export function listOpenCodeProviderRegistry(): OpenCodeProviderDescriptor[] {
  return PROVIDER_REGISTRY.map((entry) => ({
    id: entry.id,
    aliases: [...entry.aliases],
    capabilities: [...entry.capabilities],
  }));
}

export function negotiateProviderCapabilities(input: {
  provider: string | null;
  required: OpenCodeProviderCapability[];
}): { satisfied: OpenCodeProviderCapability[]; missing: OpenCodeProviderCapability[] } {
  const providerId = input.provider?.trim().toLowerCase() ?? "";
  const descriptor = PROVIDER_REGISTRY.find((entry) => entry.id === providerId);
  const supported = new Set(descriptor?.capabilities ?? BASE_CAPABILITIES);
  const required = Array.from(new Set(input.required));
  const satisfied = required.filter((capability) => supported.has(capability));
  const missing = required.filter((capability) => !supported.has(capability));
  return { satisfied, missing };
}

export function resolveOpenCodeProvider(input: {
  modelId: string | null;
  env: Record<string, string>;
}): ResolvedOpenCodeProvider {
  const normalizedModelId = normalizeProviderModelId(input.modelId);
  const parsed = parseProviderModelId(normalizedModelId);
  const provider = parsed?.provider ?? null;
  const descriptor = provider
    ? PROVIDER_REGISTRY.find((entry) => entry.id === provider)
    : null;
  return {
    modelId: normalizedModelId,
    provider,
    biller: inferOpenAiCompatibleBiller(input.env, null) ?? provider ?? "unknown",
    capabilities: [...(descriptor?.capabilities ?? BASE_CAPABILITIES)],
    contractVersion: OPENCODE_RUNTIME_CONTRACT_VERSION,
  };
}
