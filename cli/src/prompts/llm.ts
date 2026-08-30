import * as p from "@clack/prompts";
import type { LlmConfig } from "../config/schema.js";

export async function promptLlm(): Promise<LlmConfig | undefined> {
  const configureLlm = await p.confirm({
    message: "Configure an LLM provider now?",
    initialValue: false,
  });

  if (p.isCancel(configureLlm)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (!configureLlm) return undefined;

  const provider = await p.select({
    message: "LLM provider",
    options: [
      { value: "claude" as const, label: "Claude (Anthropic)" },
      { value: "openai" as const, label: "OpenAI" },
      { value: "deepseek" as const, label: "DeepSeek" },
      { value: "glm" as const, label: "Zhipu GLM" },
      { value: "kimi" as const, label: "Moonshot Kimi" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const providerLabels: Record<string, string> = {
    claude: "Anthropic",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    glm: "Zhipu GLM",
    kimi: "Moonshot Kimi",
  };

  const apiKey = await p.password({
    message: `${providerLabels[provider] ?? provider} API key`,
    validate: (val) => {
      if (!val) return "API key is required";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return { provider, apiKey };
}
