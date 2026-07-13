import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const cursorLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "CURSOR_API_KEY",
      kind: "api_key",
      label: "Cursor API key",
      setupUrl: "https://cursor.com/settings",
      placeholder: "key_…",
    },
  ],
};
