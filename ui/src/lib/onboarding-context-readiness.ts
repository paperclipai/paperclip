import type { HealthStatus } from "../api/health";

export type OnboardingContextReadinessStatus = "checking" | "ready" | "optional";

export type OnboardingContextReadiness = {
  status: OnboardingContextReadinessStatus;
  label: string;
  description: string;
};

export function resolveOnboardingContextReadiness(input: {
  health?: HealthStatus;
  isLoading: boolean;
  isError?: boolean;
}): OnboardingContextReadiness {
  if (input.isLoading) {
    return {
      status: "checking",
      label: "Extra context: checking",
      description: "Checking whether selected starter details can be attached invisibly.",
    };
  }

  if (!input.isError && input.health?.features?.onboardingStarterContextDocuments) {
    return {
      status: "ready",
      label: "Extra context: ready",
      description: "Selected starter details will be attached invisibly for future agents.",
    };
  }

  return {
    status: "optional",
    label: "Extra context: optional",
    description: "The task will still launch. Agents can use the visible task copy if hidden context is unavailable.",
  };
}

export function getOnboardingContextReadinessCopy(input: {
  health?: HealthStatus;
  isLoading: boolean;
  isError?: boolean;
}) {
  const readiness = resolveOnboardingContextReadiness(input);
  if (readiness.status === "checking") return "Checking extra context";
  return readiness.label;
}
