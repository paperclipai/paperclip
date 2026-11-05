import { t as translate } from "@/i18n";
/** Redacted presentation contracts shared with the production API. */
import type { AiProvider, AiAuthMethod, AiManagedConnectionSummary, AiConnectionBinding } from "@paperclipai/shared";
export type { AiProvider, AiAuthMethod, AiConnectionBinding } from "@paperclipai/shared";
export type AiConnectionStatus = AiManagedConnectionSummary["status"];

export const AI_PROVIDERS: Record<
  AiProvider,
  { name: string; subscriptionName?: string; logo?: string }
> = {
  github: { name: "GitHub Copilot", logo: "/brands/apps/github.svg" },
  google: { name: "Google", subscriptionName: "Google Antigravity account", logo: "/brands/apps/google.svg" },
  anthropic: {
    name: "Claude",
    subscriptionName: "Claude subscription",
    logo: "/brands/claude-color.svg",
  },
  openai: {
    name: "OpenAI",
    subscriptionName: "ChatGPT subscription",
    logo: "/brands/codex-color.svg",
  },
  openrouter: { name: "OpenRouter", logo: "/brands/apps/openrouter.svg" },
  xai: {
    name: "Grok",
    subscriptionName: "Grok subscription",
    logo: "/brands/adapters/grok.svg",
  },
};

export type AiConnectionSummary = Omit<AiManagedConnectionSummary, "isDefault"> & { isDefault?: boolean };

export interface AiConnectionRequirement {
  companyId: string;
  provider: AiProvider;
  method?: AiAuthMethod;
}

export const AI_CONNECTION_STATUS: Record<AiConnectionStatus, string> = {
  get connected() { return translate("connections:connected_c2f9b7b"); },
  get needs_attention() { return translate("connections:needs_attention_a126722"); },
  get expired() { return translate("connections:expired_a689a99"); },
  get revoked() { return translate("connections:revoked_85f17ac"); },
};

export function defaultAiConnectionName(ownerName: string | undefined, provider: AiProvider, method: AiAuthMethod) {
  const owner = ownerName?.trim();
  const prefix = owner && owner !== "You" ? `${owner}'s` : "My";
  const providerName = method === "subscription"
    ? AI_PROVIDERS[provider].subscriptionName ?? AI_PROVIDERS[provider].name
    : `${AI_PROVIDERS[provider].name} API`;
  return `${prefix} ${providerName} account`;
}

export function aiProviderSubscriptionLabel(provider: AiProvider): string | undefined {
  const keys: Partial<Record<AiProvider, string>> = { google: "google_antigravity_account_925b40b", anthropic: "claude_subscription_f9fac38", openai: "chatgpt_subscription_7d79171", xai: "grok_subscription_706d24c" };
  const key = keys[provider];
  return key ? translate(`connections:${key}`) : undefined;
}

export function aiMethodLabel(provider: AiProvider, method: AiAuthMethod) {
  return method === "subscription"
    ? (aiProviderSubscriptionLabel(provider) ?? translate("connections:subscription_unavailable_681ca16"))
    : provider === "github" ? translate("connections:personal_access_token_318e3c8") : translate("connections:api_key_cf678ca");
}

export function aiConnectionDisplayLabel(connection: AiConnectionSummary) {
  const personal = connection.ownership === "personal";
  return [
    connection.name,
    aiMethodLabel(connection.provider, connection.method),
    personal ? translate("connections:personal_40f0732") : translate("connections:company_shared_62c7551"),
    connection.accountLabel || connection.ownerName,
  ].filter(Boolean).join(" · ");
}

export function matchesAiRequirement(
  connection: AiConnectionSummary,
  requirement: AiConnectionRequirement,
) {
  return (
    connection.companyId === requirement.companyId &&
    connection.provider === requirement.provider &&
    (requirement.method === undefined || connection.method === requirement.method)
  );
}

export function personalAiDefault(
  connections: AiConnectionSummary[],
  requirement: AiConnectionRequirement,
  userId: string,
) {
  // Never choose another account because the declared default is unhealthy.
  return connections.find(
    (connection) =>
      matchesAiRequirement(connection, { ...requirement, method: undefined }) &&
      connection.ownership === "personal" &&
      connection.ownerUserId === userId &&
      connection.isDefault,
  );
}

export function aiConnectionProblem(connection?: AiConnectionSummary) {
  if (!connection)
    return translate("connections:no_connection_selected_connect_an_account_to_09146fd");
  return (
    connection.unavailableReason ??
    (connection.status === "connected"
      ? null
      : translate("connections:reconnect_this_account_to_continue_92f96a9", { value: AI_CONNECTION_STATUS[connection.status] }))
  );
}

export function bindingProblem(
  binding: AiConnectionBinding,
  requirement: AiConnectionRequirement,
  connections: AiConnectionSummary[],
  userId: string,
  _agentId: string,
) {
  if (
    binding.provider !== requirement.provider ||
    (binding.mode !== "responsible_user" && requirement.method !== undefined && binding.method !== requirement.method)
  )
    return translate("connections:choose_a_connection_compatible_with_this_provider_30d137f");
  if (binding.mode === "responsible_user")
    return aiConnectionProblem(
      personalAiDefault(connections, requirement, userId),
    );
  const connection = connections.find(
    (item) =>
      item.id === binding.connectionId &&
      item.grantId === binding.grantId &&
      item.method === binding.method &&
      matchesAiRequirement(item, requirement),
  );
  if (!connection)
    return translate("connections:this_connection_is_no_longer_available_for_fa5e058");
  if (binding.mode === "shared" && connection.ownership !== "shared")
    return translate("connections:choose_a_company_shared_connection_8ac55a4");
  if (
    binding.mode === "delegated" &&
    (connection.ownership !== "personal" ||
      connection.ownerUserId !== userId)
  )
    return translate("connections:this_credential_is_not_shared_with_you_87c0aaf");
  return aiConnectionProblem(connection);
}
