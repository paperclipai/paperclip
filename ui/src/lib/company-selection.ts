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
