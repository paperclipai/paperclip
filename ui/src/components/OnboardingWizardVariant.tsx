import { lazy, useEffect } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { useOptionalCompany } from "../context/CompanyContext";
import { useLocation, useNavigate } from "../lib/router";
import { isOnboardingPath, shouldCoverWithOnboardingWizard } from "../lib/onboarding-route";
import { DeferredOverlay } from "./DeferredOverlay";
import { LanguageSwitcher } from "./LanguageSwitcher";
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
  const requested = shouldCoverWithOnboardingWizard({
    pathname,
    onboardingOpen,
    routeRequested: isOnboardingPath(pathname) && !onboardingRouteDismissed,
  });
  return (
    <>
      {requested && companyState ? (
        // The wizard is `fixed inset-0` and covers the sidebar, which is the
        // only other place this menu exists. An agentless company opens that
        // overlay on its dashboard, so the switch has to live on the overlay.
        <OnboardingOrganizationSwitch
          companies={companyState.companies}
          selectedCompanyId={companyState.selectedCompanyId}
          onSelect={(company) => {
            closeOnboarding();
            setOnboardingRouteDismissed(true);
            companyState.setSelectedCompanyId(company.id);
            navigate(`/${company.issuePrefix}/dashboard`);
          }}
        />
      ) : null}
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
