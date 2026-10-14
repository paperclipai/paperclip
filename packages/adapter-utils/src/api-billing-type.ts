import type { AdapterBillingType } from "./types.js";

const API_KEY_NAMES: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
};

/** A model/provider name alone does not prove billing. Only a matching API
 * credential establishes API use; ambient auth files remain unclassified. */
export function apiKeyBillingType(provider: string | null, env: Record<string, string | undefined>, runtime?: "codex"): AdapterBillingType {
  // Codex's credential alias is not accepted by other OpenAI clients.
  if (provider === "openai" && runtime === "codex" && env.CODEX_API_KEY?.trim()) return "metered_api";
  const keys = provider && Object.hasOwn(API_KEY_NAMES, provider) ? API_KEY_NAMES[provider] : undefined;
  return keys?.some(key => Boolean(env[key]?.trim())) ? "metered_api" : "unknown";
}
