import type { CompanyExperimentalFeaturesConfig } from "@paperclipai/shared";
import { isUiExperimentalFeatureEnabled } from "@/lib/experimental-features";

export interface UnauthenticatedLoginAdapterInput {
  nextPath?: string;
  companyExperimentalFeatures?: CompanyExperimentalFeaturesConfig;
}

export function isUnauthenticatedDevelopmentLoginAvailable(
  companyExperimentalFeatures?: CompanyExperimentalFeaturesConfig,
): boolean {
  return isUiExperimentalFeatureEnabled("unauthenticated_login", companyExperimentalFeatures);
}

export const unauthenticatedLoginAdapter = {
  async proceed(input: UnauthenticatedLoginAdapterInput = {}) {
    if (!isUnauthenticatedDevelopmentLoginAvailable(input.companyExperimentalFeatures)) {
      throw new Error("Unauthenticated development entry is disabled.");
    }
    const target = input.nextPath?.trim() || "/";
    window.location.assign(target);
  },
};
