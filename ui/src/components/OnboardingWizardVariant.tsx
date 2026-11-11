import { lazy, useEffect } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { useLocation } from "../lib/router";
import { isOnboardingPath } from "../lib/onboarding-route";
import { DeferredOverlay } from "./DeferredOverlay";
import { LanguageSwitcher } from "./LanguageSwitcher";

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then((module) => ({ default: module.OnboardingWizard })));

/**
 * Default onboarding wizard. Conference-room chat is now the only surface left
 * behind `enableConferenceRoomChat`; onboarding stays available without that
 * experimental flag.
 */
export function OnboardingWizardVariant() {
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { closeOnboarding, setOnboardingRouteDismissed } = useDialogActions();
  const { pathname } = useLocation();
  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [pathname, setOnboardingRouteDismissed]);
  const requested = onboardingOpen || (isOnboardingPath(pathname) && !onboardingRouteDismissed);
  return (
    <>
      {requested ? (
        <div className="fixed top-4 right-4 z-[200]">
          <LanguageSwitcher className="border-border bg-background text-foreground shadow-sm" />
        </div>
      ) : null}
      <DeferredOverlay requested={requested} title="Setup" onClose={() => {
        closeOnboarding();
        if (isOnboardingPath(pathname)) setOnboardingRouteDismissed(true);
      }}><OnboardingWizard /></DeferredOverlay>
    </>
  );
}
