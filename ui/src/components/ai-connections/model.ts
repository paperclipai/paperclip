import { t } from "@/i18n";
/** Redacted presentation contracts shared with the production API. */
import type { AiProvider, AiAuthMethod, AiManagedConnectionSummary, AiConnectionBinding } from "@paperclipai/shared";
export type { AiProvider, AiAuthMethod, AiConnectionBinding } from "@paperclipai/shared";
export type AiConnectionStatus = AiManagedConnectionSummary["status"];

export const AI_PROVIDERS: Record<
  AiProvider,
  { name: string; subscriptionName?: string; logo?: string }
> = {
  anthropic: {
    name: "Claude",
    get subscriptionName() { return t("sep13Connections.claudeSubscription"); },
    logo: "/brands/claude-color.svg",
  },
  openai: {
    name: "OpenAI",
    get subscriptionName() { return t("sep13Connections.chatgptSubscription"); },
    logo: "/brands/codex-color.svg",
  },
  openrouter: { name: "OpenRouter", logo: "/brands/apps/openrouter.svg" },
  xai: {
    name: "Grok",
    get subscriptionName() { return t("sep13Connections.grokSubscription"); },
    logo: "/brands/adapters/grok.svg",
  },
};

export type AiConnectionSummary = Omit<AiManagedConnectionSummary, "isDefault"> & { isDefault?: boolean };

export interface AiConnectionRequirement {
  companyId: string;
  provider: AiProvider;
  method: AiAuthMethod;
}

export const AI_CONNECTION_STATUS: Record<AiConnectionStatus, string> = {
  get connected() { return t("sep13Connections.status_connected"); },
  get needs_attention() { return t("sep13Connections.status_needs_attention"); },
  get expired() { return t("sep13Connections.status_expired"); },
  get revoked() { return t("sep13Connections.status_revoked"); },
};

export function aiMethodLabel(provider: AiProvider, method: AiAuthMethod) {
  return method === "subscription"
    ? (AI_PROVIDERS[provider].subscriptionName ?? t("sep13Connections.subscriptionUnavailable"))
    : t("sep13Connections.apiKey");
}

export function matchesAiRequirement(
  connection: AiConnectionSummary,
  requirement: AiConnectionRequirement,
) {
  return (
    connection.companyId === requirement.companyId &&
    connection.provider === requirement.provider &&
    connection.method === requirement.method
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
      matchesAiRequirement(connection, requirement) &&
      connection.ownership === "personal" &&
      connection.ownerUserId === userId &&
      connection.isDefault,
  );
}

export function aiConnectionProblem(connection?: AiConnectionSummary) {
  if (!connection)
    return t("sep13Connections.noSelection");
  return (
    (connection.unavailableReason === "Reconnect with a separate sign-in to protect your existing terminal login."
      ? t("sep13Connections.separateSignIn")
      : connection.unavailableReason) ??
    (connection.status === "connected"
      ? null
      : t("sep13Connections.reconnectStatus", { status: AI_CONNECTION_STATUS[connection.status] }))
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
    binding.method !== requirement.method
  )
    return t("sep13Connections.incompatible");
  if (binding.mode === "responsible_user")
    return aiConnectionProblem(
      personalAiDefault(connections, requirement, userId),
    );
  const connection = connections.find(
    (item) =>
      item.id === binding.connectionId &&
      item.grantId === binding.grantId &&
      matchesAiRequirement(item, requirement),
  );
  if (!connection)
    return t("sep13Connections.unavailableForAgent");
  if (binding.mode === "shared" && connection.ownership !== "shared")
    return t("sep13Connections.chooseShared");
  if (
    binding.mode === "delegated" &&
    (connection.ownership !== "personal" ||
      connection.ownerUserId !== userId)
  )
    return t("sep13Connections.credentialNotShared");
  return aiConnectionProblem(connection);
}
