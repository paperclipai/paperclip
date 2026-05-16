import type { AdapterModel, AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS, modelProfiles as DIRECT_MODEL_PROFILES } from "../index.js";

/**
 * Bedrock cross-region inference profile prefixes that AWS publishes Anthropic
 * models under. Anthropic model IDs are *not* valid on Bedrock — Bedrock requires
 * a region-qualified prefix, e.g. `us.anthropic.*`, `eu.anthropic.*`, or an ARN.
 *
 * The list intentionally only covers the regions where Anthropic models are
 * currently inference-profiled; new regions can be added here as AWS rolls them out.
 */
const BEDROCK_REGION_PREFIXES = ["us", "eu", "apac"] as const;
type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number];

/** AWS Bedrock model IDs — region-qualified identifiers required by the Bedrock API. */
const BEDROCK_MODELS_BY_PREFIX: Record<BedrockRegionPrefix, AdapterModel[]> = {
  us: [
    { id: "us.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6 (US)" },
    { id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5 (US)" },
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5 (US)" },
  ],
  eu: [
    { id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5 (EU)" },
    { id: "eu.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5 (EU)" },
  ],
  apac: [
    { id: "apac.anthropic.claude-sonnet-4-5-20250929-v1:0", label: "Bedrock Sonnet 4.5 (APAC)" },
  ],
};

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

/**
 * Map an AWS region (e.g. `eu-central-1`, `us-east-1`, `ap-southeast-2`) to the
 * Bedrock cross-region inference-profile prefix Anthropic models are published under.
 * Falls back to `us` because the original Bedrock-Anthropic launch region was us-east.
 *
 * Reads `AWS_REGION` (Bedrock SDKs honor this) with `AWS_DEFAULT_REGION` and
 * `ANTHROPIC_BEDROCK_REGION` as alternates so operators can pin a region without
 * touching the AWS SDK env vars.
 */
export function resolveBedrockRegionPrefix(env: NodeJS.ProcessEnv = process.env): BedrockRegionPrefix {
  const region = (
    env.ANTHROPIC_BEDROCK_REGION ??
    env.AWS_REGION ??
    env.AWS_DEFAULT_REGION ??
    ""
  )
    .trim()
    .toLowerCase();
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "us";
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs for the
 * configured region; otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  if (!isBedrockEnv()) return DIRECT_MODELS;
  const prefix = resolveBedrockRegionPrefix();
  return BEDROCK_MODELS_BY_PREFIX[prefix];
}

/**
 * Pick the Bedrock model id used for the `cheap` profile in a given region.
 * Prefers Haiku (the actual cheapest Anthropic model on Bedrock); falls back to
 * the first model in the regional list if Haiku has not rolled out there yet.
 */
function pickCheapBedrockModelId(prefix: BedrockRegionPrefix): string {
  const models = BEDROCK_MODELS_BY_PREFIX[prefix];
  const haiku = models.find((m) => m.id.includes("claude-haiku"));
  return (haiku ?? models[0]).id;
}

/**
 * Return the model profiles appropriate for the current auth mode.
 * When Bedrock env vars are detected, rewrites the `cheap` profile's
 * `adapterConfig.model` to a region-correct Bedrock inference-profile id.
 * Without this, the resolver picks an Anthropic-direct id like `claude-sonnet-4-6`,
 * which Bedrock rejects with `400 The provided model identifier is invalid.`
 *
 * Only the `cheap` profile is rewritten; any other profiles added in the future
 * should either be given Bedrock-native IDs in DIRECT_MODEL_PROFILES or handled here.
 */
export async function listClaudeModelProfiles(): Promise<AdapterModelProfileDefinition[]> {
  if (!isBedrockEnv()) return DIRECT_MODEL_PROFILES;
  const prefix = resolveBedrockRegionPrefix();
  return DIRECT_MODEL_PROFILES.map((profile) => {
    if (profile.key !== "cheap") return profile;
    return {
      ...profile,
      adapterConfig: {
        ...profile.adapterConfig,
        model: pickCheapBedrockModelId(prefix),
      },
    };
  });
}

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Bedrock model IDs use region-qualified prefixes (e.g. us.anthropic.*, eu.anthropic.*) or ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
