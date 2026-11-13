import { createHash } from "node:crypto";
import { probeAiConnectionUsage, readUsage } from "./ai-connection-usage.js";
import type { AiProvider } from "@paperclipai/shared";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
function json(value: string): Record<string, unknown> { try { return object(JSON.parse(value)); } catch { return {}; } }
function claims(value: unknown) {
  if (typeof value !== "string" || value.length > 32768) return {};
  return json(Buffer.from(value.split(".")[1] ?? "", "base64url").toString());
}

export function subscriptionIdentityKey(companyId: string, provider: string, parts: string[]): string {
  return createHash("sha256").update(JSON.stringify([companyId, provider, ...parts])).digest("hex");
}

export interface SubscriptionIdentity {
  credentialKey: string;
  accountKey: string;
  verified: boolean;
  plan: string | null;
}

/** Credential-local hints cannot authenticate a provider account. In particular,
 * a user may edit an ID token independently of the bearer token sent upstream.
 * No ambient host credentials, emails, raw account IDs, or tokens leave this helper. */
export function subscriptionCredentialIdentity(companyId: string, provider: string, credential: string): SubscriptionIdentity {
  const credentialKey = subscriptionIdentityKey(companyId, provider, ["credential", credential]);
  const auth = json(credential);
  let plan: string | null = null;
  if (provider === "openai") {
    const tokens = object(auth.tokens);
    const token = claims(tokens.id_token);
    const account = object(token["https://api.openai.com/auth"]);
    plan = string(account.chatgpt_plan_type);
  }
  // Other credential formats do not yet prove a stable billing identity. Use a
  // credential-scoped record until a profile observation or manual link proves it.
  return { credentialKey, accountKey: credentialKey, verified: false, plan };
}

export async function probeSubscriptionIdentity(companyId: string, provider: AiProvider, credential: string, request: typeof fetch = fetch) {
  const identity = subscriptionCredentialIdentity(companyId, provider, credential);
  if (provider === "anthropic") {
    // Same account-scoped OAuth profile used by Claude Code / CodexBar. A
    // setup-token may lack user:profile; failure must preserve the prior record.
    const profile = await readUsage("https://api.anthropic.com/api/oauth/profile", {
      Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20",
    }, request);
    const account = object(profile.account), organization = object(profile.organization);
    const seat = string(account.uuid), workspace = string(organization.uuid);
    const type = string(organization.organization_type);
    const tier = string(organization.rate_limit_tier);
    const plan = type === "claude_max" && tier === "default_claude_max_5x" ? "max_5x"
      : type === "claude_max" && tier === "default_claude_max_20x" ? "max_20x"
      : ({ claude_pro: "pro", claude_max: "max", claude_team: "team", claude_enterprise: "enterprise" } as Record<string, string>)[type ?? ""] ?? null;
    if (!seat || !workspace) throw new Error("Subscription profile unavailable");
    return { ...identity, accountKey: subscriptionIdentityKey(companyId, provider, ["account", workspace, seat]), verified: true, plan };
  }
  const usage = await probeAiConnectionUsage({ provider, method: "subscription" }, credential, { request });
  if (usage.status !== "ok") throw new Error("Subscription profile unavailable");
  if (provider === "openai") {
    // The usage request authenticated this exact bearer token with OpenAI.
    // Only its claims may identify a seat; the separate ID token and editable
    // account-id field cannot grant billing access. An opaque bearer or a
    // selected workspace that differs from its claims stays unconfirmed.
    const auth = json(credential), tokens = object(auth.tokens);
    const token = claims(tokens.access_token ?? auth.accessToken);
    const account = object(token["https://api.openai.com/auth"]);
    const workspace = string(account.chatgpt_account_id);
    const selectedWorkspace = string(tokens.account_id ?? auth.accountId);
    const seat = string(account.chatgpt_user_id) ?? string(token.sub);
    if (workspace && seat && (!selectedWorkspace || selectedWorkspace === workspace)) {
      return { ...identity, accountKey: subscriptionIdentityKey(companyId, provider, ["account", workspace, seat]), verified: true, plan: string(usage.planType) };
    }
  }
  return { ...identity, plan: string(usage.planType) };
}
