/**
 * Shared cloud-sandbox model catalog and provider helpers.
 *
 * Used by both the OnboardingWizard and AgentConfigForm so the list of
 * known models / provider mappings stays in one place.
 */

export type ByokProvider = "anthropic" | "openai" | "google" | "openrouter";

/** Known models per provider for cloud sandbox mode (no CLI discovery needed) */
export const CLOUD_MODELS: Record<string, { id: string; label: string }[]> = {
  anthropic: [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
    { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "o3", label: "o3" },
    { id: "o4-mini", label: "o4-mini" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "codex-mini-latest", label: "Codex Mini" },
  ],
  google: [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
  openrouter: [
    { id: "minimax/minimax-m2.5", label: "MiniMax M2.5" },
    { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
    { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "openai/gpt-5.4", label: "GPT-5.4" },
    { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast" },
    { id: "qwen/qwen3-coder", label: "Qwen3 Coder" },
    { id: "mistralai/devstral-2512", label: "Devstral 2" },
  ],
};

/**
 * Map a local adapter type to its fixed provider.
 * Returns null for multi-provider adapters (pi, opencode) where the
 * user picks the provider themselves.
 */
export function getAdapterProvider(adapterType: string): ByokProvider | null {
  switch (adapterType) {
    case "claude_local":
    case "claude":
      return "anthropic";
    case "codex_local":
    case "codex":
      return "openai";
    case "gemini_local":
    case "gemini":
      return "google";
    default:
      return null; // pi, opencode = multi-provider
  }
}

/** Map from runtime name (as stored in adapterConfig.runtime) to a display label.
 *  Ordered as a 2x2 grid: Codex + Gemini (top), Pi + OpenCode (bottom). */
export const CLOUD_RUNTIME_OPTIONS = [
  { value: "claude", label: "Claude Code", recommended: true },
  { value: "codex", label: "Codex", recommended: false },
  { value: "gemini", label: "Gemini CLI", recommended: false },
  { value: "pi", label: "Pi", recommended: false },
  { value: "opencode", label: "OpenCode", recommended: false },
] as const;

/** Env key name per provider for storing the BYOK API key */
export const PROVIDER_ENV_KEY: Record<ByokProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

/** Smart label per provider for the API key input */
export const PROVIDER_KEY_LABELS: Record<ByokProvider, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Gemini API key",
  openrouter: "OpenRouter API key",
};

/** Smart placeholder per provider for the API key input */
export const PROVIDER_KEY_PLACEHOLDERS: Record<ByokProvider, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  openrouter: "sk-or-...",
};

/**
 * Infer the BYOK provider from the env keys in an adapterConfig.
 * Returns a provider if exactly one known env key is present, else null.
 */
export function inferProviderFromEnv(env: Record<string, unknown> | undefined): ByokProvider | null {
  if (!env || typeof env !== "object") return null;
  const keys = Object.keys(env);
  for (const [provider, envKey] of Object.entries(PROVIDER_ENV_KEY)) {
    if (keys.includes(envKey)) return provider as ByokProvider;
  }
  return null;
}
