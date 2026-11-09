import { lazy, useEffect } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { useLocation } from "../lib/router";
import { isOnboardingPath } from "../lib/onboarding-route";
import { DeferredOverlay } from "./DeferredOverlay";

const WorkspaceOnboarding = lazy(() => import("./WorkspaceOnboarding").then((module) => ({ default: module.WorkspaceOnboarding })));

/**
 * Workspace onboarding remains available independently of experimental chat.
 */
export function OnboardingWizardVariant() {
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { closeOnboarding, setOnboardingRouteDismissed } = useDialogActions();
  const { pathname } = useLocation();
  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [pathname, setOnboardingRouteDismissed]);
  const requested = onboardingOpen || (isOnboardingPath(pathname) && !onboardingRouteDismissed);
  const close = () => {
    closeOnboarding();
    if (isOnboardingPath(pathname)) setOnboardingRouteDismissed(true);
  };
  return <DeferredOverlay requested={requested} title="Workspace" onClose={close}>
    <WorkspaceOnboarding key={pathname} open={requested} onClose={close} />
  </DeferredOverlay>;
}
