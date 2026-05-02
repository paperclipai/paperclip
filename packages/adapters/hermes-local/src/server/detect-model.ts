import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DetectedModel {
  model: string;
  provider: string;
  baseUrl: string;
  apiMode: string;
  source: "config";
}

const VALID_PROVIDERS = [
  "auto",
  "openrouter",
  "nous",
  "openai-codex",
  "copilot",
  "copilot-acp",
  "anthropic",
  "huggingface",
  "zai",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "kilocode",
] as const;

const MODEL_PREFIX_PROVIDER_HINTS: [string, string][] = [
  ["gpt-4", "openai-codex"],
  ["gpt-5", "copilot"],
  ["o1-", "openai-codex"],
  ["o3-", "openai-codex"],
  ["o4-", "openai-codex"],
  ["claude", "anthropic"],
  ["gemini", "auto"],
  ["hermes-", "nous"],
  ["glm-", "zai"],
  ["moonshot", "kimi-coding"],
  ["kimi", "kimi-coding"],
  ["minimax", "minimax"],
  ["deepseek", "auto"],
  ["llama", "auto"],
  ["qwen", "auto"],
  ["mistral", "auto"],
  ["huggingface/", "huggingface"],
];

export async function detectModel(configPath?: string): Promise<DetectedModel | null> {
  const filePath = configPath ?? join(homedir(), ".hermes", "config.yaml");
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  return parseModelFromConfig(content);
}

export function parseModelFromConfig(content: string): DetectedModel | null {
  const lines = content.split("\n");
  let model = "";
  let provider = "";
  let baseUrl = "";
  let apiMode = "";
  let inModelSection = false;
  let modelSectionIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      modelSectionIndent = 0;
      continue;
    }

    if (inModelSection && indent <= modelSectionIndent && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/#.*$/, "").trim().replace(/^['"]/g, "").replace(/['"]$/g, "");
        if (key === "default") model = val;
        if (key === "provider") provider = val;
        if (key === "base_url") baseUrl = val;
        if (key === "api_mode") apiMode = val;
      }
    }
  }

  if (!model) return null;
  return { model, provider, baseUrl, apiMode, source: "config" };
}

export function inferProviderFromModel(model: string): string | undefined {
  const lower = model.toLowerCase();
  const bareName = lower.includes("/") ? lower.split("/").pop() : lower;
  for (const [prefix, hint] of MODEL_PREFIX_PROVIDER_HINTS) {
    if (bareName?.startsWith(prefix)) return hint;
  }
  return undefined;
}

export function resolveProvider(options: {
  explicitProvider?: string;
  detectedProvider?: string;
  detectedModel?: string;
  model?: string;
}): { provider: string; resolvedFrom: string } {
  const { explicitProvider, detectedProvider, detectedModel, model } = options;

  if (explicitProvider && (VALID_PROVIDERS as readonly string[]).includes(explicitProvider)) {
    return { provider: explicitProvider, resolvedFrom: "adapterConfig" };
  }

  if (
    detectedProvider &&
    detectedModel &&
    (VALID_PROVIDERS as readonly string[]).includes(detectedProvider) &&
    detectedModel.toLowerCase() === model?.toLowerCase()
  ) {
    return { provider: detectedProvider, resolvedFrom: "hermesConfig" };
  }

  if (model) {
    const inferred = inferProviderFromModel(model);
    if (inferred) return { provider: inferred, resolvedFrom: "modelInference" };
  }

  return { provider: "auto", resolvedFrom: "auto" };
}
