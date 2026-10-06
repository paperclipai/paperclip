/**
 * Optional endpoint override for the onboarding "API key" credential mode.
 *
 * Lets a customer point Claude Code / Codex at an OpenAI- or Anthropic-
 * compatible gateway (OmniRoute, LiteLLM, OpenRouter proxies, ...) with that
 * gateway's key, instead of needing an official Anthropic/OpenAI account.
 */

/** The environment variable each adapter reads its API endpoint from. */
const BASE_URL_ENV_KEYS: Record<string, string> = {
  claude_local: "ANTHROPIC_BASE_URL",
  codex_local: "OPENAI_BASE_URL",
};

/** Example endpoint shown as the field placeholder (OmniRoute's local default). */
const BASE_URL_PLACEHOLDERS: Record<string, string> = {
  claude_local: "http://localhost:20128",
  codex_local: "http://localhost:20128/v1",
};

/** The env var carrying the endpoint for `adapterType`, or null when unsupported. */
export function baseUrlEnvKeyFor(adapterType: string): string | null {
  return BASE_URL_ENV_KEYS[adapterType] ?? null;
}

export function baseUrlPlaceholderFor(adapterType: string): string {
  return BASE_URL_PLACEHOLDERS[adapterType] ?? "https://";
}

export function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "URL must start with http:// or https://";
  } catch {
    return "Please enter a valid URL, or leave blank for the default endpoint.";
  }
  return null;
}

/**
 * Trimmed base URL when it is a valid http(s) URL, otherwise null.
 * An empty value means "use the provider default" and also yields null.
 */
export function normalizeBaseUrl(value: string): string | null {
  if (validateBaseUrl(value)) return null;
  return value.trim() || null;
}

/**
 * Returns `env` with the base-URL override applied for `adapterType`.
 * The URL is not a secret, so it is stored as a plain binding. A no-op for
 * adapters without an endpoint variable or when `baseUrl` is empty/invalid.
 */
export function applyBaseUrlToEnv(
  env: Record<string, unknown>,
  adapterType: string,
  baseUrl: string,
): Record<string, unknown> {
  const envKey = baseUrlEnvKeyFor(adapterType);
  const normalized = normalizeBaseUrl(baseUrl);
  if (!envKey || !normalized) return env;
  return { ...env, [envKey]: { type: "plain", value: normalized } };
}
