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
  /**
   * There is no usable company list *and* the reason is a failed request rather
   * than an account that owns nothing. Consumers need the two apart: an empty
   * list is a fact to render, this is a dead end to offer a way out of.
   */
  companyListUnavailable: boolean;
  /** Re-fetches the list for the account signed in now. Pairs with the flag above. */
  retryCompanies: () => Promise<void>;
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
    // AppsConnect.tsx). Removal is what fits *here*, for a reason worth saying
    // out loud: removal notifies nobody, so on its own it would leave mounted
    // observers serving the previous account. What rebinds them is the render
    // the state updates above just scheduled — every observer re-binds to a
    // fresh query on the next render. Do not lift this call anywhere that lacks
    // that guarantee; the sign-out sweep is exactly such a place.
    queryClient.removeQueries({ queryKey: queryKeys.companies.all, exact: true });

    // Coalescing keys on the request path alone, so without this the fetch below
    // can join a `/companies` request issued under the previous session and be
    // answered with that account's companies.
    companiesApi.detachInflightList();

    // Drive the replacement fetch here rather than leaning on observer refetch
    // semantics, so the gate below lifts exactly when a list for this account
    // has landed.
    //
    // No `retry` override, though `companiesListQueryOptions` sets
    // `retry: false`. A transient blip already gets a second attempt: the
    // observer above rebinds to a fresh query on the render these state updates
    // schedule and issues its own request, so a single failure self-heals
    // (measured: two attempts either way). Adding retries here only buys extra
    // failed round trips before a real outage is reported, and the outage is
    // what needs a way out — see `companyListUnavailable` below.
    // The rejection is caught only to keep it from going unhandled — it is not
    // lost. `fetchQuery` records it on the query itself, so it arrives as
    // `error` below, which is where `companyListUnavailable` reads it from.
    // Carrying a second copy in component state is what let the two fall out of
    // step: the copy outlived the failure and kept reporting "couldn't load"
    // over a later, honest empty list.
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

  // The way out of the dead end. Not `reloadCompanies`: invalidation refetches
  // only through a mounted observer, and it leaves an errored query reporting
  // its old error, so the recovery affordance would keep telling the customer
  // the list is unavailable after a retry had already succeeded.
  const retryCompanies = useCallback(async () => {
    setAwaitingAccountScopedList(true);
    try {
      await queryClient.fetchQuery({ ...companiesListQueryOptions, staleTime: 0 });
    } catch {
      // Recorded on the query, same as the replacement fetch above.
    } finally {
      setAwaitingAccountScopedList(false);
    }
  }, [queryClient]);

  // Empty because we could not find out, as opposed to empty because the account
  // owns nothing. Derived from the query rather than tracked alongside it: the
  // query is the only thing that knows whether the last attempt succeeded, and a
  // second copy of that answer drifts — it did, reporting a failure over a later
  // empty list that was simply the truth.
  const companyListUnavailable = companies.length === 0 && Boolean(error);

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
      companyListUnavailable,
      retryCompanies,
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
      companyListUnavailable,
      retryCompanies,
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
