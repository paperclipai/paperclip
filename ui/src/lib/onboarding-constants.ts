// Shared onboarding constants, extracted from OnboardingWizard so the new
// presentational onboarding flow and the useOnboardingFlow hook share one
// source of truth for storage keys, default task copy, and error messages.

export const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";

export const DEFAULT_TASK_TITLE = "Hire your first engineer and create a hiring plan";

export const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

export const INCOMPLETE_ONBOARDING_STATE_MESSAGE =
  "Onboarding state is incomplete. Please restart onboarding and try again.";
