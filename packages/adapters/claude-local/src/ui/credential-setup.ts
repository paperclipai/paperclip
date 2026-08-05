import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const claudeLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      hint: "Create a key in the Anthropic Console. Usage bills to your Anthropic API account.",
      setupUrl: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-…",
    },
    {
      envKey: "CLAUDE_CODE_OAUTH_TOKEN",
      kind: "subscription_token",
      label: "Claude Pro/Max subscription token",
      hint: "Mint a long-lived token with `claude setup-token` on a machine where Claude Code is logged in. Token-only auth has no usage/quota reporting, and subscription usage in third-party contexts may draw from your Anthropic \"extra usage\" credits.",
      setupCommand: "claude setup-token",
      placeholder: "sk-ant-oat01-…",
    },
  ],
};
