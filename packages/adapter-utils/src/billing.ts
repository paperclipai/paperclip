/** Default OpenAI-compatible base URL when using OpenRouter with no explicit endpoint set. */
export const DEFAULT_OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api/v1";

function readEnv(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** OpenAI-compatible base URL candidates, in precedence order (matches common CLIs and OpenRouter docs). */
function readOpenAiCompatibleBaseUrl(env: NodeJS.ProcessEnv): string | null {
  return (
    readEnv(env, "OPENAI_BASE_URL") ??
    readEnv(env, "OPENAI_API_BASE") ??
    readEnv(env, "OPENAI_API_BASE_URL") ??
    readEnv(env, "OPENROUTER_API_BASE")
  );
}

export function inferOpenAiCompatibleBiller(
  env: NodeJS.ProcessEnv,
  fallback: string | null = "openai",
): string | null {
  const explicitOpenRouterKey = readEnv(env, "OPENROUTER_API_KEY");
  if (explicitOpenRouterKey) return "openrouter";

  const baseUrl = readOpenAiCompatibleBaseUrl(env);
  if (baseUrl && /openrouter\.ai/i.test(baseUrl)) return "openrouter";

  return fallback;
}

/**
 * When `OPENROUTER_API_KEY` is set but `OPENAI_API_KEY` is not, copy the key and
 * default `OPENAI_BASE_URL` so OpenAI-compatible CLIs route to OpenRouter.
 * If `OPENAI_BASE_URL` is unset or whitespace-only but `OPENAI_API_BASE` /
 * `OPENAI_API_BASE_URL` / `OPENROUTER_API_BASE` holds the real endpoint, sets
 * `OPENAI_BASE_URL` to that value so CLIs that read only `OPENAI_BASE_URL` still
 * route correctly.
 * Mutates `env` in place (same pattern as Codex/Cursor adapters).
 */
export function applyOpenRouterOpenAiEnvMapping(env: Record<string, string>): void {
  const processLike = env as unknown as NodeJS.ProcessEnv;
  const orKey = readEnv(processLike, "OPENROUTER_API_KEY");
  const oaiKey = readEnv(processLike, "OPENAI_API_KEY");
  if (!orKey || oaiKey) return;
  env.OPENAI_API_KEY = orKey;

  const fromOpenAiBaseUrl = readEnv(processLike, "OPENAI_BASE_URL");
  const baseUrl = readOpenAiCompatibleBaseUrl(processLike);
  if (!baseUrl) {
    env.OPENAI_BASE_URL = DEFAULT_OPENROUTER_OPENAI_BASE_URL;
    return;
  }

  if (!fromOpenAiBaseUrl) {
    env.OPENAI_BASE_URL = baseUrl;
  }
}
