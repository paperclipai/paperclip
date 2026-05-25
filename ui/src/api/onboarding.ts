import type {
  OnboardingApplyRequest,
  OnboardingApplyResponse,
  OnboardingAdapterOptionsResponse,
  OnboardingPickDirectoryResponse,
  OnboardingRecommendationRequest,
  OnboardingRecommendationResponse,
  OnboardingScanRequest,
  OnboardingScanResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const onboardingApi = {
  scan: (data: OnboardingScanRequest) =>
    api.post<OnboardingScanResponse>("/onboarding/scan", data),
  pickDirectory: () =>
    api.post<OnboardingPickDirectoryResponse>("/onboarding/pick-directory", {}),
  adapterOptions: () =>
    api.get<OnboardingAdapterOptionsResponse>("/onboarding/adapter-options"),
  recommend: (data: OnboardingRecommendationRequest) =>
    api.post<OnboardingRecommendationResponse>("/onboarding/recommend", data),
  apply: (data: OnboardingApplyRequest) =>
    api.post<OnboardingApplyResponse>("/onboarding/apply", data),
};
