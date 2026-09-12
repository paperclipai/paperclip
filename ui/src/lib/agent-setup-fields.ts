import { t } from "@/i18n";
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

export function setupEffortLabel(value: string): string {
  const keys: Record<string, string> = {
    off: "localizationRoutines.off",
    minimal: "localizationAgents.ui105_Minimal",
    low: "localizationAgents.ui106_Low",
    medium: "localizationAgents.ui107_Medium",
    high: "localizationAgents.ui108_High",
    xhigh: "localizationAgents.ui109_X_High",
    max: "localizationAgents.ui110_Max",
    ultra: "agentSetup.effortUltra",
  };
  return keys[value] ? t(keys[value]) : value;
}

export const SETUP_LOGIN_HINTS: Record<string, string> = {
  get cursor() { return t("agentSetup.cursorLoginHint"); },
  get gemini_local() { return t("agentSetup.geminiLoginHint"); },
  get kimi_local() { return t("agentSetup.kimiLoginHint"); },
  get grok_local() { return t("agentSetup.grokLoginHint"); },
  get hermes_local() { return t("agentSetup.hermesLoginHint"); },
};
