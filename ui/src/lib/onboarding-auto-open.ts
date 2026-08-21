/**
 * Which companies have already been offered onboarding automatically.
 *
 * The dashboard opens onboarding for a company that has no agent. That is an
 * offer, and an offer that reappears after it is declined is not one, so each
 * company gets at most one.
 *
 * Module scope rather than state inside the dashboard, on purpose. A ref dies
 * with the component, so navigating away and back would offer again, and it
 * holds one company, so visiting a second agentless company and returning to
 * the first would too. A page reload does offer again, which is the right
 * scope: that is a new visit rather than the same one continuing.
 */
const offeredCompanyIds = new Set<string>();

/**
 * Records an offer, and reports whether it is the first one for this company.
 * Returns false when onboarding has already been offered, in which case the
 * caller must not open it again.
 */
export function claimOnboardingOffer(companyId: string): boolean {
  if (offeredCompanyIds.has(companyId)) return false;
  offeredCompanyIds.add(companyId);
  return true;
}

/** Forget every offer. For tests, which must not inherit each other's state. */
export function resetOnboardingOffers(): void {
  offeredCompanyIds.clear();
}
