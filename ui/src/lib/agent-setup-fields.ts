import { DEFAULT_CODEX_LOCAL_MODEL } from "@paperclipai/adapter-codex-local";
import { claudeLocalReasoningEffortsForModel, DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";
import { grokLocalReasoningEffortsForModel } from "@paperclipai/adapter-grok-local";
import { DEEPSEEK_REASONING_EFFORTS, isDeepSeekModel } from "@paperclipai/shared";
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
  deepseek: "DEEPSEEK_API_KEY",
  zai: "ZAI_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

export function setupProviderKeys(adapter: string) {
  return adapter === "hermes_local" ? HERMES_PROVIDER_KEYS : PROVIDER_ENV_KEYS;
}

export function setupEfforts(adapter: string, model = ""): string[] {
  // DeepSeek exposes only low/high/max (it normalizes the full domain itself).
  // Both the Claude and Codex harnesses route DeepSeek through their own effort
  // controls, so list the DeepSeek domain for a DeepSeek model instead of the
  // harness's native model list. The shared helper keeps this identical to the
  // server-side MCP validation so a saved value stays editable there.
  if ((adapter === "claude_local" || adapter === "codex_local") && isDeepSeekModel(model)) {
    return [...DEEPSEEK_REASONING_EFFORTS];
  }
  switch (adapter) {
    case "claude_local":
      return [...claudeLocalReasoningEffortsForModel(model || DEFAULT_CLAUDE_LOCAL_MODEL)];
    case "codex_local":
      return codexReasoningEffortOptions(model || DEFAULT_CODEX_LOCAL_MODEL)
        .map((option) => option.value)
        .filter(Boolean);
    case "pi_local":
      return ["off", "minimal", "low", "medium", "high", "xhigh"];
    case "opencode_local":
      // OpenCode supports the full reasoning-effort domain (Minimal..Max). The
      // value is stored as adapterConfig.variant and passed as `--variant`
      // (V1) or `provider/model#variant` (V2). Keep this list aligned with
      // `openCodeThinkingEffortOptions` in AgentConfigForm so create and edit
      // offer the same choices.
      return ["minimal", "low", "medium", "high", "xhigh", "max"];
    case "grok_local":
      return [...grokLocalReasoningEffortsForModel(model)];
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
