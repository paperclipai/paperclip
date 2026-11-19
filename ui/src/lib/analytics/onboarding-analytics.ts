import { useCallback, useEffect, useRef } from "react";
import { captureProductAnalyticsEvent } from "./product-analytics";

export const ONBOARDING_ANALYTICS_EVENTS = {
  opened: "onboarding_opened",
  stepViewed: "onboarding_step_viewed",
  stepCompleted: "onboarding_step_completed",
  dismissed: "onboarding_dismissed",
} as const;

export type OnboardingAnalyticsStep = "create_agent" | "connect_model" | "review" | "launch";
export type OnboardingAnalyticsOutcome = "subscription" | "api_key" | "succeeded" | "failed";

const WIZARD_STEPS: Record<number, OnboardingAnalyticsStep> = {
  3: "create_agent",
  4: "connect_model",
  5: "review",
};

export function onboardingAnalyticsStepFor(wizardStep: number): OnboardingAnalyticsStep | null {
  return WIZARD_STEPS[wizardStep] ?? null;
}

function stepProperties(step: OnboardingAnalyticsStep | null, outcome?: OnboardingAnalyticsOutcome) {
  const properties: Record<string, string> = {};
  if (step) properties.step = step;
  if (outcome) properties.outcome = outcome;
  return properties;
}

export function captureOnboardingStepCompleted(step: OnboardingAnalyticsStep, outcome?: OnboardingAnalyticsOutcome) {
  captureProductAnalyticsEvent(ONBOARDING_ANALYTICS_EVENTS.stepCompleted, stepProperties(step, outcome));
}

export function useOnboardingAnalytics(input: {
  open: boolean;
  step: number;
  connectOutcome: OnboardingAnalyticsOutcome;
}) {
  const session = useRef<{ pendingStep: number | null; viewedStep: number } | null>(null);
  const connectOutcome = useRef(input.connectOutcome);
  connectOutcome.current = input.connectOutcome;

  const opened = useCallback((entryStep: number, renderedStep: number) => {
    if (session.current) return;
    session.current = { pendingStep: entryStep === renderedStep ? null : entryStep, viewedStep: entryStep };
    const step = onboardingAnalyticsStepFor(entryStep);
    captureProductAnalyticsEvent(ONBOARDING_ANALYTICS_EVENTS.opened, stepProperties(step));
    if (step) captureProductAnalyticsEvent(ONBOARDING_ANALYTICS_EVENTS.stepViewed, stepProperties(step));
  }, []);

  const dismissed = useCallback((step: number) => {
    if (!session.current) return;
    session.current = null;
    captureProductAnalyticsEvent(
      ONBOARDING_ANALYTICS_EVENTS.dismissed,
      stepProperties(onboardingAnalyticsStepFor(step)),
    );
  }, []);

  const finished = useCallback(() => {
    session.current = null;
  }, []);

  const { open, step } = input;
  useEffect(() => {
    const current = session.current;
    if (!open) {
      if (current) dismissed(current.viewedStep);
      return;
    }
    if (!current) return;
    if (current.pendingStep !== null) {
      if (step !== current.pendingStep) return;
      current.pendingStep = null;
    }
    const previous = current.viewedStep;
    if (previous === step) return;
    current.viewedStep = step;
    const previousStep = onboardingAnalyticsStepFor(previous);
    if (previousStep && step === previous + 1) {
      captureOnboardingStepCompleted(
        previousStep,
        previousStep === "connect_model" ? connectOutcome.current : undefined,
      );
    }
    const viewed = onboardingAnalyticsStepFor(step);
    if (viewed) captureProductAnalyticsEvent(ONBOARDING_ANALYTICS_EVENTS.stepViewed, stepProperties(viewed));
  }, [open, step]);

  return { opened, dismissed, finished };
}
