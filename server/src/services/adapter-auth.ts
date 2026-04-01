import type { Db } from "@paperclipai/db";
import type {
  AdapterAuthRequirementSource,
  AdapterAuthRequirementStatus,
  AdapterAuthStatusResponse,
  EnvBinding,
  ProviderCredentialSummary,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { providerCredentialService } from "./provider-credentials.js";

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

const PROVIDER_ALIASES: Record<string, string> = {
  "open-ai": "openai",
  chatgpt: "openai",
  claude: "anthropic",
  googleai: "google",
  xai: "xai",
  "x-ai": "xai",
};

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  cursor: ["CURSOR_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
};

type AdapterAuthRequirement = {
  requirementId: string;
  source: AdapterAuthRequirementSource;
  provider: string | null;
  requiredEnvKeys: string[];
  unresolvedReason: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeProviderAlias(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] ?? normalized;
}

function deriveEnvKeyFromProvider(provider: string): string {
  const normalized = normalizeProviderAlias(provider);
  const sanitized = normalized
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${sanitized || "PROVIDER"}_API_KEY`;
}

function normalizeEnvKey(value: string): string {
  return value.trim().toUpperCase();
}

function extractProviderFromModel(model: string | null): string | null {
  if (!model) return null;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0) return null;
  const provider = model.slice(0, slashIndex).trim();
  if (!provider) return null;
  return normalizeProviderAlias(provider);
}

function resolveManualEnvKey(adapterConfig: Record<string, unknown>, provider: string | null): string | null {
  const explicit =
    asNonEmptyString(adapterConfig.authEnvKey)
    ?? asNonEmptyString(adapterConfig.apiKeyEnvKey)
    ?? asNonEmptyString(adapterConfig.envKey)
    ?? null;

  if (explicit) {
    const envKey = normalizeEnvKey(explicit);
    return ENV_KEY_RE.test(envKey) ? envKey : null;
  }

  if (!provider) return null;
  return deriveEnvKeyFromProvider(provider);
}

export function providerEnvKeysForProvider(provider: string): string[] | null {
  const normalized = normalizeProviderAlias(provider);
  const keys = PROVIDER_ENV_KEYS[normalized];
  return keys ? [...keys] : null;
}

export function deriveAdapterAuthRequirements(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
): AdapterAuthRequirement[] {
  const fixedRequirement = (
    provider: string,
    envKeys: string[],
    reason: string,
  ): AdapterAuthRequirement[] => [{
    requirementId: `${adapterType}:${provider}`,
    source: "fixed_adapter",
    provider,
    requiredEnvKeys: envKeys,
    unresolvedReason: reason,
  }];

  if (adapterType === "codex_local") {
    return fixedRequirement(
      "openai",
      ["OPENAI_API_KEY"],
      "Codex requires OPENAI_API_KEY.",
    );
  }

  if (adapterType === "claude_local") {
    return fixedRequirement(
      "anthropic",
      ["ANTHROPIC_API_KEY"],
      "Claude requires ANTHROPIC_API_KEY.",
    );
  }

  if (adapterType === "gemini_local") {
    return fixedRequirement(
      "gemini",
      ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      "Gemini requires GEMINI_API_KEY or GOOGLE_API_KEY.",
    );
  }

  if (adapterType === "cursor") {
    return fixedRequirement(
      "cursor",
      ["CURSOR_API_KEY"],
      "Cursor requires CURSOR_API_KEY.",
    );
  }

  if (adapterType === "process" || adapterType === "http" || adapterType === "openclaw_gateway") {
    return [];
  }

  if (adapterType === "opencode_local" || adapterType === "pi_local" || adapterType === "hermes_local") {
    const providerFromConfig = asNonEmptyString(adapterConfig.provider);
    const providerFromModel = extractProviderFromModel(asNonEmptyString(adapterConfig.model));
    const provider = providerFromConfig
      ? normalizeProviderAlias(providerFromConfig)
      : providerFromModel;

    if (provider) {
      const knownEnvKeys = providerEnvKeysForProvider(provider);
      if (knownEnvKeys) {
        return [{
          requirementId: `${adapterType}:${provider}`,
          source: "provider_model",
          provider,
          requiredEnvKeys: knownEnvKeys,
          unresolvedReason: `Provider '${provider}' requires ${knownEnvKeys.join(" or ")}.`,
        }];
      }

      const manualEnvKey = resolveManualEnvKey(adapterConfig, provider);
      return [{
        requirementId: `${adapterType}:${provider}`,
        source: "manual_env_key",
        provider,
        requiredEnvKeys: manualEnvKey ? [manualEnvKey] : [],
        unresolvedReason: manualEnvKey
          ? `Provider '${provider}' requires manual credential key ${manualEnvKey}.`
          : `Provider '${provider}' requires a manual auth env key (set adapterConfig.authEnvKey).`,
      }];
    }

    const manualEnvKey = resolveManualEnvKey(adapterConfig, null);
    return [{
      requirementId: `${adapterType}:manual`,
      source: "manual_env_key",
      provider: null,
      requiredEnvKeys: manualEnvKey ? [manualEnvKey] : [],
      unresolvedReason: manualEnvKey
        ? `Configure credential for ${manualEnvKey}.`
        : "Select a provider/model or set adapterConfig.authEnvKey before creating this agent.",
    }];
  }

  return [];
}

function isConfiguredBinding(binding: unknown): boolean {
  if (typeof binding === "string") return binding.trim().length > 0;
  const bindingRecord = asRecord(binding);
  if (!bindingRecord) return false;

  const type = asNonEmptyString(bindingRecord.type);
  if (type === "plain") {
    const value = typeof bindingRecord.value === "string" ? bindingRecord.value : "";
    return value.trim().length > 0;
  }

  if (type === "secret_ref") {
    return asNonEmptyString(bindingRecord.secretId) !== null;
  }

  return false;
}

function findConfiguredEnvKey(
  adapterEnv: Record<string, unknown>,
  requiredEnvKeys: string[],
): string | null {
  for (const envKey of requiredEnvKeys) {
    if (isConfiguredBinding(adapterEnv[envKey])) return envKey;
  }
  return null;
}

function filterCredentialsForRequirement(
  credentials: ProviderCredentialSummary[],
  requirement: AdapterAuthRequirement,
): ProviderCredentialSummary[] {
  if (requirement.requiredEnvKeys.length > 0) {
    const keySet = new Set(requirement.requiredEnvKeys.map((value) => normalizeEnvKey(value)));
    return credentials.filter((credential) => keySet.has(normalizeEnvKey(credential.envKey)));
  }

  if (requirement.provider) {
    const provider = normalizeProviderAlias(requirement.provider);
    return credentials.filter((credential) => normalizeProviderAlias(String(credential.provider)) === provider);
  }

  return [];
}

function resolveRequirementStatus(
  requirement: AdapterAuthRequirement,
  adapterConfig: Record<string, unknown>,
  credentials: ProviderCredentialSummary[],
): AdapterAuthRequirementStatus {
  const adapterEnv = asRecord(adapterConfig.env) ?? {};
  const configuredEnvKey = findConfiguredEnvKey(adapterEnv, requirement.requiredEnvKeys);
  const availableCredentials = filterCredentialsForRequirement(credentials, requirement);
  const defaultCredential =
    availableCredentials.find((credential) => credential.isDefault)
    ?? null;

  if (configuredEnvKey) {
    return {
      requirementId: requirement.requirementId,
      source: requirement.source,
      provider: requirement.provider,
      requiredEnvKeys: requirement.requiredEnvKeys,
      resolved: true,
      resolvedBy: "adapter_env",
      resolvedEnvKey: configuredEnvKey,
      resolvedCredentialId: null,
      availableCredentials,
      defaultCredentialId: defaultCredential?.id ?? null,
      unresolvedReason: null,
    };
  }

  if (defaultCredential) {
    return {
      requirementId: requirement.requirementId,
      source: requirement.source,
      provider: requirement.provider,
      requiredEnvKeys: requirement.requiredEnvKeys,
      resolved: true,
      resolvedBy: "default_credential",
      resolvedEnvKey: defaultCredential.envKey,
      resolvedCredentialId: defaultCredential.id,
      availableCredentials,
      defaultCredentialId: defaultCredential.id,
      unresolvedReason: null,
    };
  }

  return {
    requirementId: requirement.requirementId,
    source: requirement.source,
    provider: requirement.provider,
    requiredEnvKeys: requirement.requiredEnvKeys,
    resolved: false,
    resolvedBy: "unresolved",
    resolvedEnvKey: null,
    resolvedCredentialId: null,
    availableCredentials,
    defaultCredentialId: null,
    unresolvedReason: requirement.unresolvedReason,
  };
}

export function resolveAdapterAuthStatus(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  credentials: ProviderCredentialSummary[],
): AdapterAuthStatusResponse {
  const requirements = deriveAdapterAuthRequirements(adapterType, adapterConfig);
  const statuses = requirements.map((requirement) =>
    resolveRequirementStatus(requirement, adapterConfig, credentials),
  );
  const unresolvedCount = statuses.filter((status) => !status.resolved).length;

  return {
    adapterType,
    requirements: statuses,
    unresolvedCount,
    status: unresolvedCount === 0 ? "resolved" : "unresolved",
  };
}

export function applyDefaultCredentialsToAdapterConfig(
  adapterConfig: Record<string, unknown>,
  status: AdapterAuthStatusResponse,
): Record<string, unknown> {
  const env = asRecord(adapterConfig.env) ?? {};
  const nextEnv: Record<string, unknown> = { ...env };
  let changed = false;

  for (const requirement of status.requirements) {
    if (requirement.resolvedBy !== "default_credential") continue;
    if (!requirement.resolvedCredentialId || !requirement.resolvedEnvKey) continue;

    const alreadySet = findConfiguredEnvKey(nextEnv, requirement.requiredEnvKeys);
    if (alreadySet) continue;

    const credential = requirement.availableCredentials.find(
      (item) => item.id === requirement.resolvedCredentialId,
    );
    if (!credential) continue;

    nextEnv[requirement.resolvedEnvKey] = {
      type: "secret_ref",
      secretId: credential.secretId,
      version: "latest",
    } satisfies EnvBinding;
    changed = true;
  }

  if (!changed) return adapterConfig;
  return {
    ...adapterConfig,
    env: nextEnv,
  };
}

export function adapterAuthService(db: Db) {
  const providerCredentials = providerCredentialService(db);

  async function getStatus(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
  ): Promise<AdapterAuthStatusResponse> {
    const credentials = await providerCredentials.list(companyId);
    return resolveAdapterAuthStatus(adapterType, adapterConfig, credentials);
  }

  async function applyDefaults(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
  ): Promise<{ adapterConfig: Record<string, unknown>; status: AdapterAuthStatusResponse }> {
    const credentials = await providerCredentials.list(companyId);
    const initialStatus = resolveAdapterAuthStatus(adapterType, adapterConfig, credentials);
    const autoAttachedConfig = applyDefaultCredentialsToAdapterConfig(adapterConfig, initialStatus);
    const finalStatus = autoAttachedConfig === adapterConfig
      ? initialStatus
      : resolveAdapterAuthStatus(adapterType, autoAttachedConfig, credentials);

    return {
      adapterConfig: autoAttachedConfig,
      status: finalStatus,
    };
  }

  async function enforceResolved(
    companyId: string,
    adapterType: string,
    adapterConfig: Record<string, unknown>,
  ): Promise<{ adapterConfig: Record<string, unknown>; status: AdapterAuthStatusResponse }> {
    const resolved = await applyDefaults(companyId, adapterType, adapterConfig);
    if (resolved.status.unresolvedCount > 0) {
      throw unprocessable(
        "Required adapter authentication is not configured.",
        resolved.status,
      );
    }
    return resolved;
  }

  return {
    getStatus,
    applyDefaults,
    enforceResolved,
  };
}
