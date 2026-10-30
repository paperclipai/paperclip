import type { AppDefinition } from "./types/app-definition.js";
import type { InstanceExperimentalSettings } from "./types/instance.js";

export function isConnectorFeatureEnabled(
  app: Pick<AppDefinition, "experimentalFeatureKey"> | null | undefined,
  settings: Partial<InstanceExperimentalSettings> | null | undefined,
): boolean {
  return !app?.experimentalFeatureKey || settings?.[app.experimentalFeatureKey] === true;
}
