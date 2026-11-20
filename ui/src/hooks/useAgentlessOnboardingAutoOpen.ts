import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { claimOnboardingOffer, dashboardOnboardingOptions } from "@/lib/onboarding-auto-open";
import { shouldRouteAgentlessCompanyToOnboarding } from "@/lib/onboarding-route";
import { onboardingDraftStorage } from "@/lib/onboarding-state";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Opens the onboarding wizard once for a company with no agent, from whichever
 * page is the company home (Dashboard, or Responsibilities when that
 * experiment is on).
 *
 * A company with no agent cannot do anything — no runs, no tasks. This also
 * closes the gap a Cloud-provisioned stack falls into: Cloud creates the
 * company before the tenant boots, so the companyless redirect never fires and
 * a seeded customer lands on the home page straight out of signup.
 *
 * Opened as the dialog rather than navigated to: the wizard is mounted
 * globally, so there is no route to race and no redirect to loop. The company
 * and step are both passed; opening with empty options would start at the
 * front door and the new-company path there would create a second company.
 * A saved agent still in setup is unfinished onboarding after reload; only
 * the matching browser draft may resume it.
 *
 * Shares the agents list query with the page, so it adds no request.
 */
export function useAgentlessOnboardingAutoOpen() {
  const { selectedCompanyId } = useCompany();
  const { openOnboarding } = useDialogActions();
  const location = useLocation();
  // `isFetching` is read alongside the data: a cached list is served while its
  // refetch runs, and an empty one from before the first hire must not pass
  // for the company's current state.
  const { data: agents, isFetching: agentsRefreshing } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const onboardingOptions = selectedCompanyId
    ? dashboardOnboardingOptions(selectedCompanyId, agents, onboardingDraftStorage.read())
    : null;
  const onboardingInitialStep = onboardingOptions?.initialStep;
  const shouldOpenOnboarding = shouldRouteAgentlessCompanyToOnboarding({
    pathname: location.pathname,
    agentsLoaded: agents !== undefined,
    agentsRefreshing,
    agentCount: onboardingOptions ? 0 : agents?.length ?? 0,
  });

  // Auto-open once per company. Every input sits behind a query, so a refetch
  // re-runs this, and the customer can navigate away and back; both would
  // otherwise reopen a wizard that was deliberately closed.
  // `claimOnboardingOffer` holds the companies already offered.
  useEffect(() => {
    if (!shouldOpenOnboarding || !selectedCompanyId || !onboardingInitialStep) return;
    if (!claimOnboardingOffer(selectedCompanyId)) return;
    openOnboarding({ companyId: selectedCompanyId, initialStep: onboardingInitialStep });
  }, [shouldOpenOnboarding, selectedCompanyId, onboardingInitialStep, openOnboarding]);
}
