/**
 * localStorage is scoped per ORIGIN, not per account, so a browser that already
 * ran onboarding will happily hand a previous company's id to a brand new
 * session. Every downstream call then targets the wrong company: goals,
 * agents, and issues get created there, and requests targeting the actual
 * company fail with authorization errors.
 *
 * So restoring is an authorization decision, not a convenience. If the saved
 * company is not one the signed-in user owns, the whole blob is discarded.
 *
 * CONTRACT: `companies` must be the caller's SETTLED companies list (its
 * loading query/context has finished, e.g. `companiesLoading === false`).
 * This function has no way to tell an empty-because-still-loading list apart
 * from an empty-because-the-account-owns-nothing list, so it always treats
 * an empty `companies` as "owns nothing" and discards a saved company id.
 * Callers must not invoke this while companies are still loading, wait for
 * the settled list first, or a legitimate draft gets discarded by mistake.
 */
export function restoreOnboardingState(
  raw: unknown,
  companies: Array<{ id: string }>,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const saved = { ...(raw as Record<string, unknown>) };

  const companyId = saved.createdCompanyId;
  if (typeof companyId !== "string" || companyId === "") return saved;

  return companies.some((c) => c.id === companyId) ? saved : null;
}
