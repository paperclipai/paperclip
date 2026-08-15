import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inferOpenAiCompatibleBiller, type AdapterBillingType } from "@paperclipai/adapter-utils";

/**
 * Pi reaches a provider either through an OAuth login (`pi` `/login`) or through
 * an API key taken from the environment or from `~/.pi/agent/auth.json`. The
 * adapter classifies a run by the provider name plus whichever credential it can
 * actually observe: the runtime environment first, then the auth file when it is
 * readable (local execution targets only). Reporting a real billing type is what
 * lets the cost ledger tell metered API spend apart from subscription usage;
 * leaving it `unknown` makes `apiRunCount`/`subscriptionRunCount` on
 * `/costs/by-agent` degenerate to 0.
 *
 * Provider ids, env var names and the `auth.json` shape come from pi's provider
 * table (`docs/providers.md` in `@earendil-works/pi-coding-agent`).
 */

/**
 * Providers billed against a prepaid/metered credit balance rather than a flat
 * subscription, however the credential was minted.
 *
 * GitHub Copilot belongs here even though it is reached through an OAuth login:
 * the seat is a subscription, but agent traffic on top of it is metered against
 * premium credits and invoiced as overage. `subscription` would be normalized to
 * `subscription_included` by the server and then zeroed by
 * `normalizeBilledCostCents`, which silently reports the largest cash lane on a
 * Copilot-routed deployment as free. `credits` keeps the cost.
 */
const PI_CREDIT_PROVIDERS = new Set(["github-copilot", "openrouter"]);

/**
 * Providers pi can reach either with an OAuth login or with an API key. An API
 * key means metered billing; a stored OAuth credential means the subscription.
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

/** How a provider credential stored in `~/.pi/agent/auth.json` was obtained. */
export type PiAuthCredentialKind = "api_key" | "oauth";

export type PiAuthCredentialKinds = Readonly<Record<string, PiAuthCredentialKind>>;

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
 * Read which credential kind pi has stored per provider. Only the `type`
 * discriminator is read; secret material is never returned, logged or retained.
 * A missing, unreadable or malformed auth file yields an empty map so callers
 * degrade to the environment heuristic instead of failing a run.
 *
 * Callers must skip this for remote execution targets: the file lives on the
 * machine that runs pi, not on the control plane.
 */
export async function readPiAuthCredentialKinds(home: string | null): Promise<PiAuthCredentialKinds> {
  const resolvedHome = home?.trim() ? path.resolve(home.trim()) : os.homedir();
  const authFilePath = path.join(resolvedHome, ".pi", "agent", "auth.json");
  let raw: string;
  try {
    raw = await fs.readFile(authFilePath, "utf-8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const kinds: Record<string, PiAuthCredentialKind> = {};
  for (const [provider, credential] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof credential !== "object" || credential === null || Array.isArray(credential)) continue;
    const type = (credential as { type?: unknown }).type;
    if (type !== "api_key" && type !== "oauth") continue;
    const key = normalizeProviderKey(provider);
    if (key) kinds[key] = type;
  }
  return kinds;
}

/**
 * Classify how a pi run is paid for.
 *
 * Anything the adapter cannot observe stays `unknown` rather than being guessed:
 * custom/self-hosted providers (`PAPERCLIP_PI_PROVIDERS`, llama.cpp, ...), and
 * dual-auth providers whose credential is neither in the environment nor visible
 * in `auth.json` (for example a remote execution target). Guessing `subscription`
 * there would zero a real metered bill; `unknown` keeps the reported cost.
 */
export function resolvePiBillingType(
  env: Record<string, string>,
  provider: string | null,
  authCredentialKinds: PiAuthCredentialKinds = {},
): AdapterBillingType {
  const key = normalizeProviderKey(provider);
  if (!key) return "unknown";
  if (PI_CREDIT_PROVIDERS.has(key)) return "credits";

  const oauthOrApiKeyEnvVars = PI_OAUTH_OR_API_KEY_PROVIDER_ENV_VARS[key];
  if (oauthOrApiKeyEnvVars) {
    if (oauthOrApiKeyEnvVars.some((envVar) => hasNonEmptyEnvValue(env, envVar))) return "api";
    const storedKind = authCredentialKinds[key];
    if (storedKind === "api_key") return "api";
    if (storedKind === "oauth") return "subscription";
    return "unknown";
  }

  return PI_API_KEY_PROVIDERS.has(key) ? "api" : "unknown";
}
