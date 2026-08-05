import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const codexLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      label: "OpenAI API key",
      hint: "Create a key in the OpenAI API console. Alternatively, you can log in with `codex login` locally and Paperclip's CODEX_HOME sync will ship the credential to remote runs.",
      setupUrl: "https://platform.openai.com/api-keys",
      placeholder: "sk-…",
    },
  ],
};
