type OnboardingRouteCompany = {
  id: string;
  issuePrefix: string;
};

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());

  // Strip a trailing /classic segment so /onboarding and /onboarding/classic
  // (and the company-prefixed equivalents) are both recognized as onboarding
  // entry points by the redirect logic.
  const trimmed =
    segments.length > 0 && segments[segments.length - 1] === "classic"
      ? segments.slice(0, -1)
      : segments;

  if (trimmed.length === 1) {
    return trimmed[0] === "onboarding";
  }

  if (trimmed.length === 2) {
    return trimmed[1] === "onboarding";
  }

  return false;
}

// The dialog-style onboarding wizard auto-opens only on the classic route. The
// new Coach-driven flow at `/onboarding` is a regular page.
export function isClassicOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 2) {
    return (
      segments[0]?.toLowerCase() === "onboarding"
      && segments[1]?.toLowerCase() === "classic"
    );
  }

  if (segments.length === 3) {
    return (
      segments[1]?.toLowerCase() === "onboarding"
      && segments[2]?.toLowerCase() === "classic"
    );
  }

  return false;
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  companyPrefix?: string;
  companies: OnboardingRouteCompany[];
}): { initialStep: 1 | 2; companyId?: string } | null {
  const { pathname, companyPrefix, companies } = params;

  // Only auto-open the dialog wizard for the classic onboarding route. The
  // new Coach-driven flow at `/onboarding` is a regular page (CoachOnboardingPage).
  if (!isClassicOnboardingPath(pathname)) return null;

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

export function shouldRedirectCompanylessRouteToOnboarding(params: {
  pathname: string;
  hasCompanies: boolean;
}): boolean {
  return !params.hasCompanies && !isOnboardingPath(params.pathname);
}
