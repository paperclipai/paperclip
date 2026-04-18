import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  companiesApi,
  type Company,
  type CreateCompanyInput,
} from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";

interface CompanyContextValue {
  companies: Company[];
  selectedCompanyId: string | null;
  selectedCompany: Company | null;
  loading: boolean;
  setSelectedCompanyId: (id: string) => void;
  createCompany: (data: CreateCompanyInput) => Promise<Company>;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);
const STORAGE_KEY = "archonos.selectedCompanyId";

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data: companies = [], isLoading } = useQuery({
    queryKey: queryKeys.companies.all,
    queryFn: () => companiesApi.list(),
  });

  // Resolve selected company
  const storedId = readStoredId();
  const selectedCompanyId =
    companies.find((c) => c.id === storedId)?.id ?? companies[0]?.id ?? null;
  const selectedCompany =
    companies.find((c) => c.id === selectedCompanyId) ?? null;

  const setSelectedCompanyId = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* ignore */
      }
      // Force re-render by invalidating companies query
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
    [queryClient],
  );

  const createMutation = useMutation({
    mutationFn: (data: CreateCompanyInput) => companiesApi.create(data),
    onSuccess: (company) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      try {
        localStorage.setItem(STORAGE_KEY, company.id);
      } catch {
        /* ignore */
      }
    },
  });

  const createCompany = useCallback(
    async (data: CreateCompanyInput) => {
      return createMutation.mutateAsync(data);
    },
    [createMutation],
  );

  return (
    <CompanyContext
      value={{
        companies,
        selectedCompanyId,
        selectedCompany,
        loading: isLoading,
        setSelectedCompanyId,
        createCompany,
      }}
    >
      {children}
    </CompanyContext>
  );
}

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error("useCompany must be used within CompanyProvider");
  return ctx;
}
