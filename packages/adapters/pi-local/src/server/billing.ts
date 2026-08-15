import { inferOpenAiCompatibleBiller, type AdapterBillingType } from "@paperclipai/adapter-utils";

/**
 * Pi reaches a provider either through an OAuth subscription (`pi` `/login`) or
 * through an API key taken from the environment or `~/.pi/agent/auth.json`.
 * The adapter cannot see `auth.json`, so it classifies a run the same way the
 * other local adapters do (claude-local, gemini-local, grok-local): by the
 * provider name plus whichever provider credential is present in the runtime
 * environment. Reporting a real billing type is what lets the cost ledger tell
 * metered API spend apart from subscription usage; leaving it `unknown` makes
 * `apiRunCount`/`subscriptionRunCount` on `/costs/by-agent` degenerate to 0.
 *
 * Provider ids and env var names come from pi's provider table
 * (`docs/providers.md` in `@earendil-works/pi-coding-agent`).
 */

/** Providers pi only reaches through an OAuth subscription. */
const PI_SUBSCRIPTION_PROVIDERS = new Set(["github-copilot"]);

/** Providers billed from a prepaid credit balance, however the key was minted. */
const PI_CREDIT_PROVIDERS = new Set(["openrouter"]);

/**
 * Providers pi can reach either with a subscription (OAuth) or with an API key.
 * An API key in the environment means metered billing; otherwise assume the
 * subscription login.
 */
const PI_OAUTH_OR_API_KEY_PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  radius: ["RADIUS_API_KEY"],
  xai: ["XAI_API_KEY"],
};

/**
 * Providers pi can only reach with an API key, so usage is metered whether the
 * key lives in the environment or in `auth.json`.
 */
const PI_API_KEY_PROVIDERS = new Set([
  "amazon-bedrock",
  "ant-ling",
  "azure-openai-responses",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "google",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "nvidia",
  "opencode",
  "opencode-go",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "together",
  "vercel-ai-gateway",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
]);

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function normalizeProviderKey(provider: string | null): string | null {
  const trimmed = provider?.trim().toLowerCase() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolvePiBiller(env: Record<string, string>, provider: string | null): string {
  return inferOpenAiCompatibleBiller(env, null) ?? provider ?? "unknown";
}

/**
 * Classify how a pi run is paid for. Custom/self-hosted providers
 * (`PAPERCLIP_PI_PROVIDERS`, llama.cpp, ...) stay `unknown` rather than being
 * guessed into the metered bucket.
 */
export function resolvePiBillingType(
  env: Record<string, string>,
  provider: string | null,
): AdapterBillingType {
  const key = normalizeProviderKey(provider);
  if (!key) return "unknown";
  if (PI_SUBSCRIPTION_PROVIDERS.has(key)) return "subscription";
  if (PI_CREDIT_PROVIDERS.has(key)) return "credits";

  const oauthOrApiKeyEnvVars = PI_OAUTH_OR_API_KEY_PROVIDER_ENV_VARS[key];
  if (oauthOrApiKeyEnvVars) {
    return oauthOrApiKeyEnvVars.some((envVar) => hasNonEmptyEnvValue(env, envVar))
      ? "api"
      : "subscription";
  }

  return PI_API_KEY_PROVIDERS.has(key) ? "api" : "unknown";
}
