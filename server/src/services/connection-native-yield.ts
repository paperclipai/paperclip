import { nativeConnectorRequiresCustomerOAuthApp, type AppDefinition, type InstanceExperimentalSettings } from "@paperclipai/shared";
import { isCloudManagedInstance } from "./cloud-instance.js";

/**
 * Decides, per discovery request, whether a native connector should yield new
 * setup to MCP aggregators: on Paperclip Cloud, when every setup path needs a
 * customer-created OAuth app. This is the same rule the Connectors catalog uses;
 * it is synchronous and never contacts the Cloud broker.
 */
export function createNativeConnectorYield(settings: Partial<InstanceExperimentalSettings>) {
  const cloudManaged = isCloudManagedInstance();
  return (app: AppDefinition): boolean => cloudManaged && nativeConnectorRequiresCustomerOAuthApp(app, settings);
}
