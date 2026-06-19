import { useConferenceRoomChatEnabled } from "@/hooks/useConferenceRoomChatEnabled";
import { OnboardingWizard } from "./OnboardingWizard";
import { OnboardingWizardClassic } from "./OnboardingWizardClassic";

/**
 * Variant selector for the onboarding wizard (PAP-136 / PAP-138, plan §3
 * Tier B).
 *
 * Flag off (the default) renders `OnboardingWizardClassic` — the
 * fork-and-freeze of master's wizard — so the experience stays
 * pixel-identical to master. Flag on renders the new capsule wizard. While
 * the flag query is still in flight nothing renders (same `loaded` pattern
 * as `ConferenceRoomChatGate`) so a flag-on user never sees the classic
 * wizard flash in first.
 */
export function OnboardingWizardVariant() {
  const { enabled, loaded } = useConferenceRoomChatEnabled();
  if (!loaded) return null;
  return enabled ? <OnboardingWizard /> : <OnboardingWizardClassic />;
}
