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

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { selectedOrgId } = useOrg();
  const [selectionSource, setSelectionSource] = useState<CompanySelectionSource>("bootstrap");
  const [selectedCompanyId, setSelectedCompanyIdState] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));

  const { data: companies = [], isLoading, error } = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: async () => {
      try {
        return await companiesApi.list();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return [];
        }
        throw err;
      }
    },
    retry: false,
  });
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
  // Prefers: stored id (if still in current org) → current selection (if in org) → first in-org.
  useEffect(() => {
    if (companies.length === 0) return;

    const selectableCompanies = sidebarCompanies.length > 0 ? sidebarCompanies : companiesInOrg;
    if (selectableCompanies.length === 0) return;

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && selectableCompanies.some((c) => c.id === stored)) {
      if (selectedCompanyId !== stored) setSelectedCompanyIdState(stored);
      return;
    }
    if (selectedCompanyId && selectableCompanies.some((c) => c.id === selectedCompanyId)) return;

    const next = selectableCompanies[0]!.id;
    setSelectedCompanyIdState(next);
    setSelectionSource("bootstrap");
    localStorage.setItem(STORAGE_KEY, next);
  }, [companies, companiesInOrg, selectedCompanyId, sidebarCompanies]);

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
