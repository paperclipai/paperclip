import {
  AI_PROVIDERS,
  aiRuntimeConnectionBindingSchema,
  isAiConnectionCompatible,
  type AiConnectionBinding,
  type AiRuntimeConnectionBinding,
  type AiProvider,
} from "@paperclipai/shared";

// Only keys read by the child's provider express a child auth override.
// A config copied from another provider can retain unrelated keys.
const PROVIDER_AUTH_ENV_KEYS: Record<AiProvider, readonly string[]> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL"],
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  openai: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  openrouter: ["OPENROUTER_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "PAPERCLIP_OPENCODE_PROVIDERS"],
  xai: ["XAI_API_KEY", "GROK_API_KEY", "GROK_HOME", "XAI_BASE_URL"],
  antigravity: ["GEMINI_API_KEY", "AGY_API_KEY", "ANTIGRAVITY_API_KEY"],
};

/** A hire inherits a connection choice, never its manager's credentials or identity. */
export function defaultAiConnectionForHire(
  adapterType: string,
  config: Record<string, unknown>,
  managerBinding: unknown,
): AiRuntimeConnectionBinding | undefined {
  const compatible = (binding: AiConnectionBinding) =>
    isAiConnectionCompatible(binding, adapterType, config.model, config.provider, config.acpxAgent);
  const inherited = aiRuntimeConnectionBindingSchema.safeParse(managerBinding);
  // Unmanaged parents keep their existing login and credential-reference paths.
  if (!inherited.success) return undefined;
  const env = config.env && typeof config.env === "object" ? config.env as Record<string, unknown> : {};
  const hasChildAuth = (provider: AiProvider) =>
    PROVIDER_AUTH_ENV_KEYS[provider].some((key) => env[key] !== undefined);
  const withChildAuthPrecedence = (binding: AiConnectionBinding) =>
    hasChildAuth(binding.provider) ? undefined : binding;
  if (inherited.data.mode === "router") {
    // The host validates pool membership, access and harness compatibility for
    // the new agent. Never silently replace an incompatible pool with local auth.
    // OpenCode also supports explicitly configured providers whose models are
    // outside the managed OpenRouter catalog. Their auth still takes precedence.
    const childProvider = adapterType === "opencode_local"
      || (adapterType === "paperclip_runner" && config.provider === "opencode")
      ? "openrouter"
      : AI_PROVIDERS.find((provider) =>
        compatible({ provider, method: "api_key", mode: "responsible_user" }));
    return childProvider && hasChildAuth(childProvider) ? undefined : inherited.data;
  }
  if (inherited.data.mode !== "delegated" && compatible(inherited.data)) {
    return withChildAuthPrecedence(inherited.data);
  }
  // The selected provider's personal default supplies the actual sign-in method
  // at run time. A provider without an account can be connected on the first task.
  for (const provider of AI_PROVIDERS) {
    const binding = { provider, method: "api_key", mode: "responsible_user" } as const;
    if (compatible(binding)) return withChildAuthPrecedence(binding);
  }
  return undefined;
}
