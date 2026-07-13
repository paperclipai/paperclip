import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const piLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      setupUrl: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-…",
    },
  ],
};
