import { lazy, useEffect } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { useOptionalCompany } from "../context/CompanyContext";
import { useLocation, useNavigate } from "../lib/router";
import { isOnboardingPath } from "../lib/onboarding-route";
import { DeferredOverlay } from "./DeferredOverlay";
import { invalidateOnboardingActions } from "./onboarding-actions";
import { OnboardingOrganizationSwitch } from "./OnboardingOrganizationSwitch";

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then((module) => ({ default: module.OnboardingWizard })));

/**
 * Default onboarding wizard. Conference-room chat is now the only surface left
 * behind `enableConferenceRoomChat`; onboarding stays available without that
 * experimental flag.
 */
export function OnboardingWizardVariant() {
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { closeOnboarding, setOnboardingRouteDismissed } = useDialogActions();
  const companyState = useOptionalCompany();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [pathname, setOnboardingRouteDismissed]);
  const requested = onboardingOpen || (isOnboardingPath(pathname) && !onboardingRouteDismissed);
  return <>
    {requested && companyState ? (
      <OnboardingOrganizationSwitch
        companies={companyState.companies}
        selectedCompanyId={companyState.selectedCompanyId}
        onSelect={(company) => {
          invalidateOnboardingActions();
          closeOnboarding();
          setOnboardingRouteDismissed(true);
          companyState.setSelectedCompanyId(company.id, { source: "route_sync" });
          navigate(`/${company.issuePrefix}/dashboard`);
        }}
      />
    ) : null}
    <DeferredOverlay requested={requested} title="Setup" onClose={() => {
      invalidateOnboardingActions();
      closeOnboarding();
      if (isOnboardingPath(pathname)) setOnboardingRouteDismissed(true);
    }}><OnboardingWizard /></DeferredOverlay>
  </>;
}
