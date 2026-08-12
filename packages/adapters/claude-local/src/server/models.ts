import { createHash } from "node:crypto";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

const ANTHROPIC_MODELS_ENDPOINT = "/v1/models";
const ANTHROPIC_MODELS_TIMEOUT_MS = 5000;
const ANTHROPIC_MODELS_CACHE_TTL_MS = 60_000;
const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API.
 *
 * Inference-profile IDs are prefixed by region family, and the families are not a simple
 * prefix swap: version suffixes diverge (Sonnet 4.5 is `-v2:0` under `us`, `-v1:0` under `eu`),
 * and a family does not always carry the same models (`jp` has no Opus 5 profile). Each family
 * is therefore listed explicitly rather than derived.
 *
 * A family's profiles are only offered in the regions that publish them: `us.` profiles do not
 * exist outside `us-*`, so they cannot serve as a general fallback. `global.` profiles are
 * published in every region checked, so unrecognised regions fall back to `global` instead.
 *
 * Every ID below was verified ACTIVE on 2026-07-31 with
 * `aws bedrock list-inference-profiles --region <region>`.
 */
type BedrockRegionFamily = "us" | "eu" | "au" | "jp" | "global";

const BEDROCK_MODELS_BY_FAMILY: Record<BedrockRegionFamily, AdapterModel[]> = {
  us: [
    { id: "us.anthropic.claude-opus-4-8-v1", label: "Bedrock Opus 4.8" },
    { id: "us.anthropic.claude-fable-5-v1", label: "Bedrock Fable 5" },
    { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
  ],
  // eu-west-1.
  eu: [
    { id: "eu.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
    { id: "eu.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
    { id: "eu.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
    { id: "eu.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
    { id: "eu.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
    { id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5" },
    { id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
  ],
  // ap-southeast-2. The `apac.` family only carries Claude 3.x-era profiles, so Australian
  // regions use `au.` for anything current.
  au: [
    { id: "au.anthropic.claude-opus-5", label: "Bedrock Opus 5" },
    { id: "au.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5" },
    { id: "au.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
    { id: "au.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
    { id: "au.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
    { id: "au.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5" },
    { id: "au.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
  ],
  // ap-northeast-1. This family publishes no Opus 5 or Sonnet 5 profile.
  jp: [
    { id: "jp.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8" },
    { id: "jp.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7" },
    { id: "jp.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
    { id: "jp.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5" },
    { id: "jp.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
  ],
  // Verified in us-east-1, eu-west-1, ap-southeast-1, ap-southeast-2 and ap-northeast-1.
  // These profiles can route a request to any region, so they are a fallback rather than a
  // default: a region with its own family keeps that family, which respects data residency.
  global: [
    { id: "global.anthropic.claude-opus-5", label: "Bedrock Opus 5 (global)" },
    { id: "global.anthropic.claude-sonnet-5", label: "Bedrock Sonnet 5 (global)" },
    { id: "global.anthropic.claude-fable-5", label: "Bedrock Fable 5 (global)" },
    { id: "global.anthropic.claude-opus-4-8", label: "Bedrock Opus 4.8 (global)" },
    { id: "global.anthropic.claude-opus-4-7", label: "Bedrock Opus 4.7 (global)" },
    { id: "global.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6 (global)" },
    { id: "global.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5 (global)" },
    { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5 (global)" },
  ],
};

/**
 * Regions whose residency-specific family is not implied by the region prefix. Only regions with
 * verified profile IDs are listed; any other `ap-*` region falls back to `global`.
 */
const BEDROCK_REGION_FAMILY_BY_REGION: Record<string, BedrockRegionFamily> = {
  "ap-southeast-2": "au",
  "ap-northeast-1": "jp",
};

/**
 * Regions that publish each family's profiles. This table decides whether to *reject* a model ID an
 * operator typed, so it is deliberately wider than BEDROCK_MODELS_BY_FAMILY, which lists only IDs
 * verified ACTIVE. `apac` appears here but not in the catalogue: its profiles exist, and are too old
 * to serve a bundled default.
 */
const BEDROCK_FAMILY_REGION_PREFIXES: Record<string, readonly string[]> = {
  us: ["us-"],
  eu: ["eu-"],
  au: ["ap-southeast-2", "ap-southeast-4"],
  jp: ["ap-northeast-1", "ap-northeast-3"],
  apac: ["ap-"],
};

export type BedrockEnv = Record<string, string | undefined>;

export function configuredAwsRegion(env: BedrockEnv = process.env): string {
  return (env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || "").toLowerCase();
}

let warnedAboutMissingRegion = false;

function resolveBedrockRegionFamily(): BedrockRegionFamily {
  const region = configuredAwsRegion();
  // No configured region: keep the previous default rather than guess. Say so once, because the
  // default is silent otherwise, and it offers US profiles to an operator who may have no US access.
  if (!region) {
    if (!warnedAboutMissingRegion) {
      warnedAboutMissingRegion = true;
      console.warn(
        "[paperclip] Bedrock is enabled and no AWS_REGION or AWS_DEFAULT_REGION is set. " +
          "Offering us.anthropic.* inference profiles, which only work from a us-* region. " +
          "Set AWS_REGION if your Bedrock access is elsewhere.",
      );
    }
    return "us";
  }
  const mapped = BEDROCK_REGION_FAMILY_BY_REGION[region];
  if (mapped) return mapped;
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  return "global";
}

function bedrockModelsForRegion(): AdapterModel[] {
  return BEDROCK_MODELS_BY_FAMILY[resolveBedrockRegionFamily()];
}

let cached: { keyFingerprint: string; baseUrl: string; expiresAt: number; models: AdapterModel[] } | null = null;

function isBedrockEnv(env: BedrockEnv = process.env): boolean {
  return (
    env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
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
  if (isBedrockEnv()) return dedupeModels(bedrockModelsForRegion());

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
  warnedAboutMissingRegion = false;
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}

/**
 * Read the region out of a Bedrock ARN, which is its fourth colon-separated field. Returns the empty
 * string for an ARN with no region, and `null` when the value is not a Bedrock ARN at all, so a
 * caller can tell "no region named" apart from "not an ARN".
 */
function bedrockArnRegion(model: string): string | null {
  const lower = model.toLowerCase();
  if (!lower.startsWith("arn:")) return null;
  const fields = lower.split(":");
  // arn : partition : service : region : account : resource
  if (fields.length < 6 || fields[2] !== "bedrock") return null;
  return fields[3] ?? "";
}

/**
 * Check whether a Bedrock model ID can resolve in the region `env` configures. Bedrock does not
 * accept an inference profile from another region family, so a `us.` profile configured in an EU-only
 * deployment fails at run time. This lets setup reject it earlier, while the operator is still there
 * to read the message.
 *
 * Pass the environment the model will run under, not this process's. An agent's `adapterConfig.env`
 * overlays `process.env` at execution, so it can name a different region, and it is the one that
 * decides whether the profile resolves.
 *
 * An ID is only rejected when `env` names the target region. A server that does not itself run
 * Bedrock can still store setup for a worker that does, and that worker's region is not visible here,
 * so such an ID is accepted. A family that is absent from the table above is also accepted, because
 * an unknown family cannot be shown to be wrong.
 */
export function isBedrockModelUsableInConfiguredRegion(model: string, env: BedrockEnv = process.env): boolean {
  if (!isBedrockModelId(model)) return false;
  if (!isBedrockEnv(env)) return true;
  const region = configuredAwsRegion(env);
  if (!region) return true;
  // An ARN names its own region, so a mismatch is visible here. Bedrock resolves a profile against
  // the endpoint of the configured region, so an ARN from another region does not resolve, however
  // fully the operator wrote it out.
  const arnRegion = bedrockArnRegion(model);
  if (arnRegion !== null) return arnRegion === "" || arnRegion === region;
  const family = /^([a-z0-9-]+)\.anthropic\./.exec(model.toLowerCase())?.[1];
  // `global.` profiles are published in every region checked.
  if (!family || family === "global") return true;
  const prefixes = BEDROCK_FAMILY_REGION_PREFIXES[family];
  if (!prefixes) return true;
  return prefixes.some((prefix) => region.startsWith(prefix));
}
