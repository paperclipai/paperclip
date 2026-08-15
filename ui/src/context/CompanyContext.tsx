import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Company } from "@paperclipai/shared";
import { authApi } from "../api/auth";
import { companiesApi } from "../api/companies";
import { companiesListQueryOptions, type CompanyListResult } from "../api/companies-query";
import { queryKeys } from "../lib/queryKeys";
import type { CompanySelectionSource } from "../lib/company-selection";
type CompanySelectionOptions = { source?: CompanySelectionSource };

interface CompanyContextValue {
  companies: Company[];
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
  // An already-selected company only needs to EXIST — not to be featured in
  // the sidebar. The Layout route-sync selects whatever company the URL names
  // (archived included, since archived pages are still routable); if this
  // resolver vetoed that selection against the sidebar-filtered list, the two
  // effects would re-select against each other forever and blow React's
  // nested-update limit (the archived-company blank-screen crash). The
  // sidebar filter keeps shaping fresh boots below, where no explicit
  // selection exists yet.
  if (input.selectedCompanyId && input.companies.some((company) => company.id === input.selectedCompanyId)) {
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
  /**
   * Whether the company request failed. An error is not an answer, and this
   * branch is destructive.
   *
   * `companiesListQueryOptions` sets `retry: false`, and a request that fails
   * before ever succeeding leaves `data` undefined - which the provider
   * defaults to `{ companies: [], unauthorized: false }`. That is
   * indistinguishable from "this account was asked, and owns nothing", so a
   * single failed request on a cold load would clear the customer's stored
   * company and drop them onto whichever company sorts first next time.
   *
   * Not clearing costs nothing: a stored id that no longer resolves is
   * ignored by {@link resolveBootstrapCompanySelection}, which checks it
   * against the current list before using it.
   */
  errored: boolean;
}) {
  if (input.errored) return false;
  return !input.isLoading && !input.unauthorized && input.companies.length === 0;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(null);

  const { data: companiesResult = { companies: [], unauthorized: false }, isLoading, error } =
    useQuery<CompanyListResult>(companiesListQueryOptions);
  const companies = companiesResult.companies;
  const companyListUnauthorized = companiesResult.unauthorized;
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );

  // The `["companies"]` entry is shared app-wide and carries no account identity,
  // so it outlives a change of account in this tab: the previous account's list
  // keeps being served, and the effect below would auto-select from it and write
  // that company id to localStorage. Signing in through the app drops the entry,
  // but nothing does when the session lapses server-side or a second account
  // signs in on another tab — so watch the account itself.
  const { data: session, isPending: isSessionPending } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const sessionUserId = session?.user.id ?? null;
  const observedUserIdRef = useRef<string | null | undefined>(undefined);
  const [awaitingAccountScopedList, setAwaitingAccountScopedList] = useState(false);

  useEffect(() => {
    // Until the session settles the account is unknown, not changed.
    if (isSessionPending) return;
    const previousUserId = observedUserIdRef.current;
    observedUserIdRef.current = sessionUserId;
    // First settled observation is this tab's boot: no previous account to leave.
    if (previousUserId === undefined || previousUserId === sessionUserId) return;

    // The live selection belongs to the account that just went away. The stored
    // one deliberately survives: resolveBootstrapCompanySelection re-validates it
    // against the incoming list, so an account signing back in keeps its company
    // while an unrelated account cannot inherit it.
    setSelectedCompanyIdState(null);
    setSelectionSource("bootstrap");
    setAwaitingAccountScopedList(true);
    // `removeQueries`, not `resetQueries`: reset rewinds the update counters
    // `isFetchedAfterMount` is derived from while mounted observers keep their
    // pre-reset baseline, which strands consumers gating on that flag (see
    // AppsConnect.tsx). Removing the entry leaves nothing readable from the
    // previous account and gives observers a fresh query to fetch against.
    queryClient.removeQueries({ queryKey: queryKeys.companies.all, exact: true });

    // Drive the replacement fetch here rather than leaning on observer refetch
    // semantics, so the gate below lifts exactly when a list for this account
    // has landed.
    let cancelled = false;
    void queryClient
      .fetchQuery({ ...companiesListQueryOptions, staleTime: 0 })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setAwaitingAccountScopedList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSessionPending, queryClient, sessionUserId]);

  // Auto-select first company when list loads
  useEffect(() => {
    // Nothing may be derived from the list until one has been fetched for the
    // account signed in now.
    if (awaitingAccountScopedList) return;
    if (isLoading) return;
    // An errored list says nothing about which companies this account has, and
    // `retry: false` makes a single network blip stick. Treat it as undecided
    // rather than as "no companies", which would clear the stored selection.
    if (error) return;
    if (companies.length === 0) {
      if (shouldClearStoredCompanySelection({
        companies,
        isLoading: false,
        unauthorized: companyListUnauthorized,
        errored: error !== null,
      })) {
        if (selectedCompanyId !== null) {
          setSelectedCompanyIdState(null);
        }
        localStorage.removeItem(STORAGE_KEY);
      }
      return;
    }

    const next = resolveBootstrapCompanySelection({
      companies,
      sidebarCompanies,
      selectedCompanyId,
      storedCompanyId: localStorage.getItem(STORAGE_KEY),
    });
    if (next === null || next === selectedCompanyId) return;
    setSelectedCompanyIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [
    awaitingAccountScopedList,
    companies,
    companyListUnauthorized,
    error,
    isLoading,
    selectedCompanyId,
    sidebarCompanies,
  ]);

  const setSelectedCompanyId = useCallback((companyId: string, options?: CompanySelectionOptions) => {
    setSelectedCompanyIdState(companyId);
    setSelectionSource(options?.source ?? "manual");
    localStorage.setItem(STORAGE_KEY, companyId);
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

/**
 * Non-throwing variant of {@link useCompany}. Returns null when called outside a
 * CompanyProvider instead of throwing, so components that may render in
 * provider-less surfaces (e.g. exported/standalone markdown) can read company
 * state without crashing.
 */
export function useOptionalCompany(): CompanyContextValue | null {
  return useContext(CompanyContext);
}
