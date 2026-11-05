import {
  connectionMethodAcceptsCustomerOAuthClient,
  connectionMethodSupportsAutomaticOAuth,
  getAvailableConnectionMethods,
} from "./app-definitions.js";
import type { AppDefinition, ConnectionMethodDef } from "./types/app-definition.js";
import type { InstanceExperimentalSettings } from "./types/instance.js";

export function isConnectorFeatureEnabled(
  app: Pick<AppDefinition, "experimentalFeatureKey"> | null | undefined,
  settings: Partial<InstanceExperimentalSettings> | null | undefined,
): boolean {
  return !app?.experimentalFeatureKey || settings?.[app.experimentalFeatureKey] === true;
}

function channelMethodEnabled(
  method: ConnectionMethodDef,
  settings: Partial<InstanceExperimentalSettings> | null | undefined,
): boolean {
  if (method.provider === "agentmail") return true;
  if (method.provider === "github") return settings?.enableGitHubReviewBots === true;
  return settings?.enableChatConnectors === true;
}

/**
 * True when every setup path this instance offers for a native connector first
 * needs the customer to create an OAuth app with the provider (no Paperclip-managed
 * client, no dynamic registration, and no enabled chat setup). Catalog and agent
 * discovery then offer equivalent MCP aggregator sign-in for new setup. Callers keep
 * the native connector for saved connections and when no aggregator serves the app.
 */
export function nativeConnectorRequiresCustomerOAuthApp(
  app: AppDefinition | null | undefined,
  settings: Partial<InstanceExperimentalSettings> | null | undefined,
): boolean {
  if (!app || !isConnectorFeatureEnabled(app, settings)) return false;
  const methods = getAvailableConnectionMethods(app).filter((method) => method.purpose !== "ai"
    && (method.purpose !== "channel" || channelMethodEnabled(method, settings)));
  return methods.length > 0 && methods.every((method) => method.purpose !== "channel"
    && connectionMethodAcceptsCustomerOAuthClient(method)
    && !connectionMethodSupportsAutomaticOAuth(method));
}
