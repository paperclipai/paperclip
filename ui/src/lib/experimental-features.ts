import {
  isExperimentalFeatureEnabled,
  type CompanyExperimentalFeaturesConfig,
  type ExperimentalFeatureKey,
} from "@paperclipai/shared";

export const UI_EXPERIMENTAL_MODE_ENV = "VITE_PAPERCLIP_EXPERIMENTAL_MODE";

export function isUiExperimentalModeEnabled(): boolean {
  return import.meta.env.VITE_PAPERCLIP_EXPERIMENTAL_MODE === "true";
}

export function isUiExperimentalFeatureEnabled(
  feature: ExperimentalFeatureKey,
  companyExperimentalFeatures?: CompanyExperimentalFeaturesConfig,
): boolean {
  return isExperimentalFeatureEnabled({
    feature,
    environmentExperimentalModeEnabled: isUiExperimentalModeEnabled(),
    isDevelopmentEnvironment: import.meta.env.DEV,
    companyEnabledFeatures: companyExperimentalFeatures?.enabledFeatures,
  });
}
