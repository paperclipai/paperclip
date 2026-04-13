function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl =
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL");
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}

/**
 * When `OPENROUTER_API_KEY` is set but `OPENAI_API_KEY` is not, copy the key and
 * default `OPENAI_BASE_URL` so OpenAI-compatible CLIs route to OpenRouter.
 * Mutates `env` in place (same pattern as Codex/Cursor adapters).
 */
export function applyOpenRouterOpenAiEnvMapping(env: Record<string, string>): void {
  if (!env.OPENROUTER_API_KEY || env.OPENAI_API_KEY) return;
  env.OPENAI_API_KEY = env.OPENROUTER_API_KEY;
  if (!env.OPENAI_BASE_URL && !env.OPENAI_API_BASE && !env.OPENAI_API_BASE_URL) {
    env.OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
  }
}
