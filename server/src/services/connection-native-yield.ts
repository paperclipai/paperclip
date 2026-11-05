import { nativeConnectorRequiresCustomerOAuthApp, type AppDefinition, type InstanceExperimentalSettings } from "@paperclipai/shared";
import { isCloudManagedInstance } from "./cloud-instance.js";
import {
  appWithPaperclipCloudConnectorAvailability,
  isPaperclipCloudConnectorStrategy,
  paperclipCloudConnectorCapabilitiesFromEnv,
} from "./paperclip-cloud-connector.js";

/**
 * Decides, per discovery request, whether a native connector should yield new
 * setup to MCP aggregators: on Paperclip Cloud, when every setup path the
 * instance offers needs a customer-created OAuth app. This mirrors the
 * Connectors catalog, including the advertised Cloud connector profiles.
 */
export function createNativeConnectorYield(settings: Partial<InstanceExperimentalSettings>) {
  const cloudManaged = isCloudManagedInstance();
  let profiles: Promise<readonly string[] | null> | undefined;
  return async function yieldsToAggregators(app: AppDefinition): Promise<boolean> {
    if (!cloudManaged) return false;
    if (!app.methods.some((method) => isPaperclipCloudConnectorStrategy(method.oauthStrategy))) {
      return nativeConnectorRequiresCustomerOAuthApp(app, settings);
    }
    // Without the advertised profiles a managed method may still work; keep the native connector.
    profiles ??= paperclipCloudConnectorCapabilitiesFromEnv().catch(() => null);
    const advertised = await profiles;
    return advertised !== null
      && nativeConnectorRequiresCustomerOAuthApp(appWithPaperclipCloudConnectorAvailability(app, advertised), settings);
  };
}
