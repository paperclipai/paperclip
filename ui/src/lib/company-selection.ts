export type CompanySelectionSource = "manual" | "route_sync" | "bootstrap";

interface BounceCandidateCompany {
  id: string;
  name: string;
  issuePrefix: string;
  status: string;
}

/**
 * Decides whether a navigation that landed on an archived company's URL
 * should bounce to an active company instead of dwelling in the archive.
 *
 * Stale state deposits users into archived companies long after archiving:
 * remembered last-visited paths, browser history, bookmarks, and restored
 * tabs all outlive the archive. Rendering those pages is safe, but it is
 * never where the user wants to *be* — the sidebar does not even list the
 * company. Cold arrivals therefore bounce to an active company.
 *
 * Deliberate visits still work: when the archived company is already the
 * selection (the user chose it from the companies list), there is no
 * bounce, so its settings and unarchive flows stay reachable. When no
 * active company exists there is nowhere better to go, so the archive
 * renders rather than bouncing into a dead end.
 */
export function resolveArchivedCompanyBounce(params: {
  matchedCompany: BounceCandidateCompany | null;
  selectedCompanyId: string | null;
  companies: BounceCandidateCompany[];
}): BounceCandidateCompany | null {
  const { matchedCompany, selectedCompanyId, companies } = params;
  if (!matchedCompany || matchedCompany.status !== "archived") return null;
  if (selectedCompanyId === matchedCompany.id) return null;

  const selectedActive = companies.find(
    (company) => company.id === selectedCompanyId && company.status !== "archived",
  );
  return selectedActive ?? companies.find((company) => company.status !== "archived") ?? null;
}

export type CompanyArchiveDeparture =
  | { kind: "company"; company: BounceCandidateCompany }
  | { kind: "cloud_portfolio"; url: string }
  | { kind: "companies_list" };

/**
 * Decides where the app should take the user after they archive a company
 * from its own settings page. Staying put is never right: the page they are
 * on belongs to the company they just archived, and the only visible change
 * would be the archive button going inert.
 *
 * Another active company wins — the user still has somewhere to work, so
 * switch there (mirroring the cold-arrival bounce above). With no active
 * company left on a Cloud instance, the whole organization is on its way to
 * being archived by the control plane, so leave for the Cloud portfolio's
 * manage view. Self-hosted with nothing active falls back to the companies
 * list, which shows the archived state and owns the unarchive affordance.
 */
export function resolveCompanyArchiveDeparture(params: {
  archivedCompanyId: string;
  companies: BounceCandidateCompany[];
  cloudPortfolioUrl: string | null;
}): CompanyArchiveDeparture {
  const { archivedCompanyId, companies, cloudPortfolioUrl } = params;
  const nextCompany = companies.find(
    (company) => company.id !== archivedCompanyId && company.status !== "archived",
  );
  if (nextCompany) return { kind: "company", company: nextCompany };
  if (cloudPortfolioUrl) return { kind: "cloud_portfolio", url: cloudPortfolioUrl };
  return { kind: "companies_list" };
}

export function shouldSyncCompanySelectionFromRoute(params: {
  selectionSource: CompanySelectionSource;
  selectedCompanyId: string | null;
  routeCompanyId: string;
}): boolean {
  const { selectionSource, selectedCompanyId, routeCompanyId } = params;

  if (selectedCompanyId === routeCompanyId) return false;

  // Let manual company switches finish their remembered-path navigation first.
  if (selectionSource === "manual" && selectedCompanyId) {
    return false;
  }

  return true;
}
