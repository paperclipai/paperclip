import { t as translateOct26, useTranslation as useOct26Translation } from "@/i18n";
import { lazy, useEffect } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { useLocation } from "../lib/router";
import { isOnboardingPath } from "../lib/onboarding-route";
import { DeferredOverlay } from "./DeferredOverlay";

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then((module) => ({ default: module.OnboardingWizard })));

/**
 * Default onboarding wizard. Conference-room chat is now the only surface left
 * behind `enableConferenceRoomChat`; onboarding stays available without that
 * experimental flag.
 */
export function OnboardingWizardVariant() {
  useOct26Translation();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { closeOnboarding, setOnboardingRouteDismissed } = useDialogActions();
  const { pathname } = useLocation();
  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [pathname, setOnboardingRouteDismissed]);
  const requested = onboardingOpen || (isOnboardingPath(pathname) && !onboardingRouteDismissed);
  return <DeferredOverlay requested={requested} title={translateOct26("pages.apps.tabs.setup")} onClose={() => {
    closeOnboarding();
    if (isOnboardingPath(pathname)) setOnboardingRouteDismissed(true);
  }}><OnboardingWizard /></DeferredOverlay>;
}
