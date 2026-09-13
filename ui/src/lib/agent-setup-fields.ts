import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { codexReasoningEffortOptions } from "./codex-reasoning-effort";
import { PROVIDER_ENV_KEYS } from "./provider-credential";

/** Only controls consumed by each adapter's config builder and runtime belong here. */
export const SETUP_CREDENTIAL_KEYS: Record<string, string> = {
  cursor: "CURSOR_API_KEY",
  cursor_cloud: "CURSOR_API_KEY",
  gemini_local: "GEMINI_API_KEY",
  kimi_local: "KIMI_MODEL_API_KEY",
  hermes_gateway: "API_SERVER_KEY",
};

export const HERMES_PROVIDER_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

export function setupProviderKeys(adapter: string) {
  return adapter === "hermes_local" ? HERMES_PROVIDER_KEYS : PROVIDER_ENV_KEYS;
}

export function setupEfforts(adapter: string, model = ""): string[] {
  switch (adapter) {
    case "claude_local":
      return ["low", "medium", "high"];
    case "codex_local":
      return codexReasoningEffortOptions(model || DEFAULT_CODEX_LOCAL_MODEL)
        .map((option) => option.value)
        .filter(Boolean);
    case "pi_local":
      return ["off", "minimal", "low", "medium", "high", "xhigh"];
    case "grok_local":
      return ["low", "medium", "high"];
    default:
      return [];
  }
}

export const SETUP_LOGIN_HINTS: Record<string, string> = {
  cursor:
    "Use a Cursor API key, or run agent login on the selected environment's host.",
  gemini_local:
    "Use a Gemini API key, or an existing supported Gemini CLI login on the selected environment's host.",
  kimi_local:
    "Use a Kimi API key and model settings below, or run kimi login on the selected environment's host.",
  grok_local:
    "Grok Build uses its CLI sign-in. Run grok login on the selected environment's host, then test the connection here.",
  hermes_local:
    "Use a provider API key, or the existing Hermes provider configuration on the selected environment's host.",
};
