import { useEffect } from "react";
import { useLocation, useParams } from "@/lib/router";
import { useDialog } from "@/context/DialogContext";
import { useCompany } from "@/context/CompanyContext";
import { resolveRouteOnboardingOptions } from "@/lib/onboarding-route";
import { CloudOnboardingFlow } from "./onboarding/CloudOnboardingFlow";

/**
 * App-integration shell for onboarding. Owns the open/close + route logic and
 * renders the CloudOnboardingFlow (the real app targets the cloud flow; the
 * local flow is harness-only for now). Onboarding opens either explicitly via
 * the dialog context (openOnboarding) or automatically on the /onboarding route
 * (and its /:companyPrefix/onboarding "add an agent" variant).
 */
export function OnboardingWizardVariant() {
  const {
    onboardingOpen,
    onboardingOptions,
    closeOnboarding,
    onboardingRouteDismissed,
    setOnboardingRouteDismissed,
  } = useDialog();
  const { companies, loading: companiesLoading } = useCompany();
  const location = useLocation();
  const { companyPrefix } = useParams<{ companyPrefix?: string }>();

  // Reset the route-dismissed flag when navigating to a different path, so the
  // route can re-open onboarding after the user has dismissed it elsewhere.
  useEffect(() => {
    setOnboardingRouteDismissed(false);
  }, [location.pathname]);

  // Support opening from the /onboarding route in addition to the dialog. Wait
  // for companies to load before resolving a company-scoped route so we don't
  // momentarily treat an existing-company entry as a fresh one.
  const routeOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
        });

  const open = onboardingOpen || (routeOptions !== null && !onboardingRouteDismissed);
  if (!open) return null;

  const options = onboardingOpen ? onboardingOptions : routeOptions ?? {};
  const existingCompany = options.companyId
    ? companies.find((company) => company.id === options.companyId)
    : undefined;

  function handleClose() {
    closeOnboarding();
    // On the /onboarding route the shell is also kept open by the route itself,
    // so closing must mark the route dismissed — otherwise `open` stays true and
    // the flow re-renders instead of handing back to the launcher card (PAP-52).
    setOnboardingRouteDismissed(true);
  }

  return (
    <CloudOnboardingFlow
      initialStep={existingCompany ? "agent" : "start"}
      existingCompany={
        existingCompany
          ? { id: existingCompany.id, prefix: existingCompany.issuePrefix }
          : undefined
      }
      onClose={handleClose}
    />
  );
}
