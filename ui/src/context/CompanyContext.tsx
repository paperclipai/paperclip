import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";

import { queryKeys } from "../lib/queryKeys";
import type { CompanySelectionSource } from "../lib/company-selection";
import { useOrg } from "./OrgContext";
type CompanySelectionOptions = { source?: CompanySelectionSource };
type CompanyListResult = { companies: Company[]; unauthorized: boolean };

interface CompanyContextValue {
  companies: Company[];
  companiesInOrg: Company[];
  selectedCompanyId: string | null;
  selectedCompany: Company | null;
  selectionSource: CompanySelectionSource;
  loading: boolean;
  error: Error | null;
  setSelectedCompanyId: (companyId: string, options?: CompanySelectionOptions) => void;
  reloadCompanies: () => Promise<void>;
  createCompany: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) => Promise<Company>;
}

const STORAGE_KEY = "paperclip.selectedCompanyId";

const CompanyContext = createContext<CompanyContextValue | null>(null);

/**
 * Returns the company whose `issuePrefix` matches the first segment of the
 * given URL pathname (case-insensitive), or `null` if none matches.
 *
 * Each route lives under `/<ISSUE_PREFIX>/...` so the URL itself encodes the
 * active company per browser tab. This helper lets storage-driven bootstrap
 * defer to the URL whenever the URL already names a known company — which is
 * what keeps two tabs viewing different companies from drifting into each
 * other via shared `localStorage`.
 */
export function findCompanyByUrlPrefix(
  pathname: string,
  companies: Array<Pick<Company, "id" | "issuePrefix">>,
): Pick<Company, "id" | "issuePrefix"> | null {
  const firstSegment = pathname.split("/").filter(Boolean)[0];
  if (!firstSegment) return null;
  const upper = firstSegment.toUpperCase();
  return companies.find((c) => c.issuePrefix.toUpperCase() === upper) ?? null;
}

function readCurrentPathname(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname ?? "/";
}

export function resolveBootstrapCompanySelection(input: {
  companies: Array<Pick<Company, "id">>;
  sidebarCompanies: Array<Pick<Company, "id">>;
  selectedCompanyId: string | null;
  storedCompanyId: string | null;
}) {
  if (input.companies.length === 0) return null;

  const selectableCompanies = input.sidebarCompanies.length > 0
    ? input.sidebarCompanies
    : input.companies;
  if (input.selectedCompanyId && selectableCompanies.some((company) => company.id === input.selectedCompanyId)) {
    return input.selectedCompanyId;
  }
  if (input.storedCompanyId && selectableCompanies.some((company) => company.id === input.storedCompanyId)) {
    return input.storedCompanyId;
  }
  return selectableCompanies[0]?.id ?? null;
}

export function shouldClearStoredCompanySelection(input: {
  companies: Array<Pick<Company, "id">>;
  isLoading: boolean;
  unauthorized: boolean;
}) {
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { selectedOrgId } = useOrg();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);

  const { data: companiesResult = { companies: [], unauthorized: false }, isLoading, error } = useQuery<CompanyListResult>({
    queryKey: queryKeys.companies.all,
    queryFn: async () => {
      try {
        return { companies: await companiesApi.list(), unauthorized: false };
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return { companies: [], unauthorized: true };
        }
        throw err;
      }
    },
    retry: false,
  });
  const companies = companiesResult.companies;
  const companyListUnauthorized = companiesResult.unauthorized;
  const companiesInOrg = useMemo(
    () =>
      selectedOrgId
        ? companies.filter((company) => company.organizationId === selectedOrgId)
        : companies,
    [companies, selectedOrgId],
  );
  const sidebarCompanies = useMemo(
    () => companiesInOrg.filter((company) => company.status !== "archived"),
    [companiesInOrg],
  );

  // Auto-select a company when list loads or when selected org changes.
  //
  // The URL prefix is the source of truth for the active company in any given
  // browser tab — each route lives under `/<ISSUE_PREFIX>/...`. So we only
  // seed from `localStorage` when the URL has no recognized company prefix
  // (e.g. `/home`, `/organizations`). When the URL already names a known
  // company, we leave the in-memory selection alone and let Layout's
  // route-sync effect drive it. This prevents tab 1 from being silently
  // pulled to tab 2's company after tab 2 writes its choice to storage.
  //
  // Once an in-memory selection exists for this tab, we never re-read storage
  // here — storage is a bootstrap aid, not a live cross-tab channel.
  useEffect(() => {
    if (isLoading) return;
    if (companies.length === 0) {
      if (shouldClearStoredCompanySelection({ companies, isLoading: false, unauthorized: companyListUnauthorized })) {
        if (selectedCompanyId !== null) {
          setSelectedCompanyIdState(null);
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      return;
    }

    const selectableCompanies = sidebarCompanies.length > 0 ? sidebarCompanies : companiesInOrg;
    if (selectableCompanies.length === 0) return;

    // If this tab's URL already names a known company, defer to the route.
    // Layout's route-sync effect will call setSelectedCompanyId with
    // source="route_sync" and the correct company id for *this* tab.
    const urlCompany = findCompanyByUrlPrefix(readCurrentPathname(), selectableCompanies as Array<Pick<Company, "id" | "issuePrefix">>);
    if (urlCompany) return;

    // No URL prefix (or unknown one): if we already have a valid in-memory
    // selection, keep it. Don't re-read storage — another tab may have just
    // written a different company there.
    if (selectedCompanyId && selectableCompanies.some((c) => c.id === selectedCompanyId)) return;

    // Fresh bootstrap (no URL prefix and no in-memory pick): seed from
    // storage if it still points at a selectable company, otherwise fall
    // back to the first selectable company.
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && selectableCompanies.some((c) => c.id === stored)) {
      setSelectedCompanyIdState(stored);
      return;
    }

    const next = selectableCompanies[0]!.id;
    setSelectedCompanyIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [companies, companiesInOrg, companyListUnauthorized, isLoading, selectedCompanyId, sidebarCompanies]);

  const setSelectedCompanyId = useCallback((companyId: string, options?: CompanySelectionOptions) => {
    const source = options?.source ?? "manual";
    setSelectedCompanyIdState(companyId);
    setSelectionSource(source);
    // Don't broadcast tab-local route syncs to other tabs via storage. A
    // route_sync is "this tab's URL just told us which company is active",
    // which is per-tab state. If we wrote that to localStorage, two tabs
    // on different companies would clobber each other's stored last-pick
    // and corrupt the bootstrap signal for any future fresh tab.
    //
    // Manual switches (sidebar/command palette) and bootstrap picks still
    // persist so a brand-new tab landing on `/home` or `/organizations`
    // can re-open the user's most recent company.
    if (source !== "route_sync") {
      localStorage.setItem(STORAGE_KEY, companyId);
    }
  }, []);

  const reloadCompanies = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) =>
      companiesApi.create(data),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setSelectedCompanyId(company.id);
    },
  });

  const createCompany = useCallback(
    async (data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
    }) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );

  const value = useMemo(
    () => ({
      companies,
      companiesInOrg,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      loading: isLoading,
      error: error as Error | null,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    }),
    [
      companies,
      companiesInOrg,
      selectedCompanyId,
      selectedCompany,
      selectionSource,
      isLoading,
      error,
      setSelectedCompanyId,
      reloadCompanies,
      createCompany,
    ],
  );

  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) {
    throw new Error("useCompany must be used within CompanyProvider");
  }
  return ctx;
}
