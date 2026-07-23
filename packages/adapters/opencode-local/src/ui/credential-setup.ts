import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const openCodeLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      hint: "OpenCode uses whichever provider API key matches the selected model.",
    },
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      label: "OpenAI API key",
    },
    {
      envKey: "OPENROUTER_API_KEY",
      kind: "api_key",
      label: "OpenRouter API key",
    },
  ],
};
