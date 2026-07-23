import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const geminiLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "GEMINI_API_KEY",
      kind: "api_key",
      label: "Gemini API key",
      setupUrl: "https://aistudio.google.com/apikey",
      placeholder: "AIza…",
    },
  ],
};
