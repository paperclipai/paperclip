import type { AdapterModel } from "@paperclipai/adapter-utils";
import { models as DIRECT_MODELS } from "../index.js";

/** AWS Bedrock model IDs — global inference profile identifiers that work in any region. */
const BEDROCK_MODELS: AdapterModel[] = [
  { id: "global.anthropic.claude-opus-4-6-v1", label: "Bedrock Opus 4.6" },
  { id: "global.anthropic.claude-sonnet-4-6", label: "Bedrock Sonnet 4.6" },
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

/** Check whether a model ID is a Bedrock-native identifier (not an Anthropic API short name). */
/** Matches global IDs (global.anthropic.*), cross-region IDs (us.anthropic.*), and ARNs. */
export function isBedrockModelId(model: string): boolean {
  return /^\w+\.anthropic\./.test(model) || model.startsWith("arn:aws:bedrock:");
}
