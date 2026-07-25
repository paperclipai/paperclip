import { OnboardingWizard } from "./OnboardingWizard";

/**
 * Default onboarding wizard. Conference-room chat is now the only surface left
 * behind `enableConferenceRoomChat`; onboarding stays available without that
 * experimental flag.
 */
export function OnboardingWizardVariant() {
  return <OnboardingWizard />;
}
