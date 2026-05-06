export type CompanySelectionSource = "manual" | "route_sync" | "bootstrap";

export function shouldSyncCompanySelectionFromRoute(params: {
  selectionSource: CompanySelectionSource;
  selectedCompanyId: string | null;
  routeCompanyId: string;
  routeChangedSinceSelection?: boolean;
}): boolean {
  const {
    selectionSource,
    selectedCompanyId,
    routeCompanyId,
    routeChangedSinceSelection = false,
  } = params;

  if (selectedCompanyId === routeCompanyId) return false;

  // Let manual company switches finish their remembered-path navigation first.
  if (selectionSource === "manual" && selectedCompanyId && !routeChangedSinceSelection) {
    return false;
  }

  return true;
}
