import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

/**
 * AWS Bedrock model IDs using global inference profiles.
 * Global profiles (global.anthropic.*) route requests to the nearest available
 * region automatically, so they work for US, EU, and AP users alike.
 * See: https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "global.anthropic.claude-opus-4-7-v1", label: "Bedrock Opus 4.7" },
  { id: "global.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "global.anthropic.claude-sonnet-4-6-v1", label: "Bedrock Sonnet 4.6" },
  { id: "global.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" },
  { id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", label: "Bedrock Haiku 4.5" },
];

function isBedrockEnv(): boolean {
  return (
    process.env.CLAUDE_CODE_USE_BEDROCK === "1" ||
    process.env.CLAUDE_CODE_USE_BEDROCK === "true" ||
    (typeof process.env.ANTHROPIC_BEDROCK_BASE_URL === "string" &&
      process.env.ANTHROPIC_BEDROCK_BASE_URL.trim().length > 0)
  );
}

/**
 * Return the model list appropriate for the current auth mode.
 * When Bedrock env vars are detected, returns Bedrock-native model IDs;
 * otherwise returns standard Anthropic API model IDs.
 */
export async function listClaudeModels(): Promise<AdapterModel[]> {
  return isBedrockEnv() ? BEDROCK_MODELS : DIRECT_MODELS;
}

/** Check whether a model ID is a Bedrock-native identifier (region-qualified prefix or ARN). */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
