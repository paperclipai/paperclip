import { createHash } from "node:crypto";
import type {
  AdapterEnvironmentCheck,
  AdapterModel,
  AdapterModelProfileDefinition,
} from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS, modelProfiles as STATIC_MODEL_PROFILES } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "us.anthropic.claude-opus-4-8-v1", label: "Bedrock Opus 4.8" },
  { id: "us.anthropic.claude-fable-5-v1", label: "Bedrock Fable 5" },
  { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

/**
 * Bedrock-native id for the `cheap` model profile. The profile preserves a
 * Sonnet "lower-cost lane" semantically, so under Bedrock it resolves to the
 * Bedrock Sonnet 4.5 id. Sourced from BEDROCK_MODELS so the profile id and the
 * validation list can never drift apart.
 */
export const BEDROCK_CHEAP_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v2:0";

export function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

function fingerprint(apiKey: string): string {
  const digest = createHash("sha256").update(apiKey).digest("base64url").slice(0, 16);
  return `${apiKey.length}:${digest}`;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function mergedWithFallback(models: AdapterModel[]): AdapterModel[] {
  return dedupeModels([
    ...models,
    ...DIRECT_MODELS,
  ]);
}

function resolveAnthropicApiKey(): string | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  return apiKey && apiKey.length > 0 ? apiKey : null;
}

function resolveAnthropicBaseUrl(): string {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  return baseUrl && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, "") : "https://api.anthropic.com";
}

async function fetchAnthropicModels(apiKey: string, baseUrl: string): Promise<AdapterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_MODELS_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${ANTHROPIC_MODELS_ENDPOINT}`, {
      headers: {
        "anthropic-version": ANTHROPIC_API_VERSION,
        "x-api-key": apiKey,
      },
      signal: controller.signal,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    const models: AdapterModel[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as { id?: unknown; display_name?: unknown };
      if (typeof record.id !== "string" || record.id.trim().length === 0) continue;
      const displayName =
        typeof record.display_name === "string" && record.display_name.trim().length > 0
          ? record.display_name
          : record.id;
      models.push({
        id: record.id,
        label: displayName,
      });
    }
    return dedupeModels(models);
  } catch (error) {
    console.warn("[paperclip] Claude model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadClaudeModels(options?: { forceRefresh?: boolean }): Promise<AdapterModel[]> {
  if (isBedrockEnv()) return dedupeModels(BEDROCK_MODELS);

  const fallback = dedupeModels(DIRECT_MODELS);
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return fallback;

  const now = Date.now();
  const baseUrl = resolveAnthropicBaseUrl();
  const keyFingerprint = fingerprint(apiKey);
  if (
    options?.forceRefresh !== true &&
    cached &&
    cached.keyFingerprint === keyFingerprint &&
    cached.baseUrl === baseUrl &&
    cached.expiresAt > now
  ) {
    return cached.models;
  }

  const fetched = await fetchAnthropicModels(apiKey, baseUrl);
  if (fetched.length > 0) {
    const merged = mergedWithFallback(fetched);
    cached = {
      keyFingerprint,
      baseUrl,
      expiresAt: now + ANTHROPIC_MODELS_CACHE_TTL_MS,
      models: merged,
    };
    return merged;
  }

  if (cached && cached.keyFingerprint === keyFingerprint && cached.baseUrl === baseUrl && cached.models.length > 0) {
    return cached.models;
  }

  return fallback;
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels();
}

export async function refreshClaudeModels(): Promise<AdapterModel[]> {
  return loadClaudeModels({ forceRefresh: true });
}

export function resetClaudeModelsCacheForTests() {
  cached = null;
}

/**
 * Resolve the model profiles for the active auth mode.
 *
 * The static `modelProfiles` export hard-codes an Anthropic-API short id
 * (`claude-sonnet-4-6`) for the `cheap` profile. That id is invalid on Bedrock:
 * passing it as `--model` returns a 400, and even when the execute-time guard
 * strips it the CLI falls back to its own short-id default, which also 400s. So
 * under Bedrock we rewrite the `cheap` profile to a Bedrock-native id. Off
 * Bedrock the static (direct-Anthropic) profiles are already valid and pass
 * through unchanged. Wired into the registry as `listModelProfiles`, which the
 * server prefers over the static export. (MAS-221)
 */
export async function listClaudeModelProfiles(): Promise<AdapterModelProfileDefinition[]> {
  if (!isBedrockEnv()) return STATIC_MODEL_PROFILES;
  return STATIC_MODEL_PROFILES.map((profile) =>
    profile.key === "cheap"
      ? {
          ...profile,
          adapterConfig: { ...profile.adapterConfig, model: BEDROCK_CHEAP_MODEL_ID },
        }
      : profile,
  );
}

/** True when `model` appears in the model list valid for the active auth mode. */
export function isKnownModelId(model: string, available: AdapterModel[]): boolean {
  return available.some((entry) => entry.id === model);
}

/**
 * Validate every adapter-owned model profile's resolved model id against the
 * active model list, surfacing an invalid id at config-load as a typed
 * `AdapterEnvironmentCheck` (level "error") instead of a cryptic mid-run 400.
 *
 * Scope is intentionally limited to adapter-owned profile models — the auth-mode
 * model lists are not exhaustive of every deployed model, so validating
 * arbitrary user-configured `config.model` would produce false positives. The
 * profile ids, by contrast, are fully controlled here and must stay valid.
 */
export async function validateModelProfileModels(opts?: {
  profiles?: AdapterModelProfileDefinition[];
  available?: AdapterModel[];
}): Promise<AdapterEnvironmentCheck[]> {
  const bedrock = isBedrockEnv();
  const available = opts?.available ?? (await listClaudeModels());
  const profiles = opts?.profiles ?? (await listClaudeModelProfiles());
  const checks: AdapterEnvironmentCheck[] = [];
  for (const profile of profiles) {
    const model = profile.adapterConfig?.model;
    if (typeof model !== "string" || model.trim().length === 0) continue;
    if (isKnownModelId(model, available)) continue;
    checks.push({
      code: "claude_model_profile_invalid",
      level: "error",
      message: `Model profile "${profile.key}" resolves to model id "${model}", which is not valid for the active ${bedrock ? "Bedrock" : "Anthropic"} auth mode.`,
      detail: `Valid ids: ${available.map((entry) => entry.id).join(", ")}`,
      hint: bedrock
        ? "On Bedrock, profile models must be region-qualified ids (e.g. us.anthropic.*). Update the profile to a Bedrock-native id."
        : "Update the profile to a valid Anthropic model id.",
    });
  }
  return checks;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
