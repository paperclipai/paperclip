type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    return segments[0]?.toLowerCase() === "onboarding";
  }

  if (segments.length === 2) {
    return segments[1]?.toLowerCase() === "onboarding";
  }

  return false;
}

/**
 * The company prefix in an onboarding pathname, or undefined when there is
 * none.
 *
 * `OnboardingWizard` renders as a full-screen overlay beside `<Routes>` rather
 * than inside it (`App.tsx`), so it has no route match and `useParams()`
 * returns nothing there — `companyPrefix` was always undefined and the wizard
 * always opened at step 1, even when the URL named a company. `useLocation()`
 * needs only the router, not a match, so the pathname is the signal that
 * survives where params do not.
 *
 * Deliberately parses the same shape as {@link isOnboardingPath}: the prefix is
 * the first of exactly two segments. Anything else has no prefix to read.
 */
export function companyPrefixFromOnboardingPath(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined;
  if (segments[1]?.toLowerCase() !== "onboarding") return undefined;
  return segments[0];
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companyPrefix, companies } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!companyPrefix) {
    return { initialStep: 1 };
  }

  const matchedCompany =
    companies.find(
      (company) =>
        company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedCompany) {
    return { initialStep: 1 };
  }

  return { initialStep: 2, companyId: matchedCompany.id };
}

/**
 * Whether a company with no agents should be sent to onboarding rather than
 * left on the dashboard.
 *
 * A company with no agent cannot do anything: no runs, no tasks, nothing to
 * show. The dashboard already says so in a banner with a "Create one here"
 * link, which asks the customer to notice a problem the product could simply
 * fix for them.
 *
 * It also closes the gap a Cloud-provisioned stack falls into. Cloud creates
 * the company before the tenant boots, so `shouldRedirectCompanylessRouteToOnboarding`
 * never fires — a seeded customer arrives at an empty dashboard having just
 * answered a signup flow, and nothing routes them onward.
 *
 * `agentsLoaded` is required rather than optional on purpose. Callers hold
 * agents as `Agent[] | undefined` while the query is in flight, and an absent
 * list reads exactly like an empty one — redirecting on that would bounce
 * every user through onboarding on each cold load.
 */
export function shouldRouteAgentlessCompanyToOnboarding(params: {
  pathname: string;
  agentsLoaded: boolean;
  agentCount: number;
}): boolean {
  if (!params.agentsLoaded) return false;
  if (params.agentCount > 0) return false;
  // Already there. Redirecting onto the path we are on is the loop that
  // "finished the wizard but created no agent" would otherwise spin in.
  return !isOnboardingPath(params.pathname);
}

export function shouldRedirectCompanylessRouteToOnboarding(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return !params.hasCompanies && !isOnboardingPath(params.pathname);
}

/**
 * Whether the onboarding wizard is currently covering the screen — either
 * opened explicitly via the dialog context or auto-opened from the
 * /onboarding route and not yet dismissed. While this is true the route
 * launcher must not render interactive content, so it hands off fully to the
 * full-screen wizard instead of staying clickable/focusable behind it
 * (PAP-52).
 */
export function isOnboardingWizardActive(params: {
  onboardingOpen: boolean;
  routeDismissed: boolean;
}): boolean {
  return params.onboardingOpen || !params.routeDismissed;
}
