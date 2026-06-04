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
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const apiKey = await p.password({
    message: `${provider === "claude" ? "Anthropic" : "OpenAI"} API key`,
    validate: (val) => {
      if (!val) return "API key is required";
    },
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (provider === "claude") {
    return { provider, apiKey };
  }

  const baseUrl = await p.text({
    message: "OpenAI-compatible base URL",
    placeholder: "https://api.openai.com/v1",
    defaultValue: "https://api.openai.com/v1",
    validate: (val) => {
      if (!val) return undefined;
      try {
        new URL(val);
        return undefined;
      } catch {
        return "Enter a valid URL";
      }
    },
  });

  if (p.isCancel(baseUrl)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const trimmedBaseUrl = String(baseUrl).trim();
  return {
    provider,
    apiKey,
    ...(trimmedBaseUrl && trimmedBaseUrl !== "https://api.openai.com/v1"
      ? { baseUrl: trimmedBaseUrl }
      : {}),
  };
}
