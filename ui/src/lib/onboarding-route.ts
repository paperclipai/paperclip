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

/** The wizard step that asks for the company's mission. */
export const ONBOARDING_MISSION_STEP = 2;

/**
 * The wizard step that asks for the first agent.
 *
 * A company that already has its mission has answered steps 1 and 2 — Cloud
 * collects both at signup and the seed writes the mission as a company-level
 * goal. Opening such a company on "what is the mission?" asks the customer
 * something they answered minutes earlier on another origin, which is the
 * seam the seeded arc exists to remove.
 */
export const ONBOARDING_AGENT_STEP = 3;

export type ExistingCompanyOnboardingStep =
  | typeof ONBOARDING_MISSION_STEP
  | typeof ONBOARDING_AGENT_STEP;

/**
 * The step a company that already exists belongs on.
 *
 * `undefined` means the mission is not known: the goal lookup has not answered
 * yet, or it failed. Both read as "no mission". That direction of error costs
 * the customer the mission step, which they can answer; the opposite would
 * skip a question nobody answered and leave the company without a mission.
 */
export function onboardingStepForCompany(
  companyHasMission: boolean | undefined,
): ExistingCompanyOnboardingStep {
  return companyHasMission === true ? ONBOARDING_AGENT_STEP : ONBOARDING_MISSION_STEP;
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
  /**
   * Whether the matched company already has its mission (a company-level
   * goal). See {@link onboardingStepForCompany} for what `undefined` means.
   */
  companyHasMission?: boolean;
}): { initialStep: 1 | ExistingCompanyOnboardingStep; companyId?: string } | null {
  const { pathname, companyPrefix, companies, companyHasMission } = params;

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

  return {
    initialStep: onboardingStepForCompany(companyHasMission),
    companyId: matchedCompany.id,
  };
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

/**
 * Whether the wizard's Back button is offered on the current step.
 *
 * A run never walks back behind the step it entered on: those steps either do
 * not apply to it (an existing company is already named, and its mission is
 * hydrated rather than asked for) or were completed elsewhere. Walking back
 * into step 1 while holding a company is the sharpest case — that step creates
 * a company, so it would make a second one.
 */
export function canGoBackFromOnboardingStep(params: {
  currentStep: number;
  entryStep: number;
}): boolean {
  return params.currentStep > 1 && params.currentStep > params.entryStep;
}

/**
 * Whether a completed progress-bar segment can be clicked to jump back to it.
 *
 * Same bound as {@link canGoBackFromOnboardingStep}. The progress bar applies
 * only the "already completed" half of the rule, which lets a run entered on
 * an existing company jump to the name and mission steps the Back button
 * deliberately withholds.
 */
export function canJumpToOnboardingStep(params: {
  targetStep: number;
  currentStep: number;
  entryStep: number;
}): boolean {
  return (
    params.targetStep < params.currentStep && params.targetStep >= params.entryStep
  );
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
