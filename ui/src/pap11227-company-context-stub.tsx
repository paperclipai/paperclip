import type { ReactNode } from "react";

const COMPANY_ID = "11111111-2222-3333-4444-555555555555";

export const companyContextValue = {
  selectedCompanyId: COMPANY_ID,
  selectedCompany: { id: COMPANY_ID, name: "PAP-11227 QA Co" },
  companies: [{ id: COMPANY_ID, name: "PAP-11227 QA Co" }],
  selectionSource: "manual" as const,
  loading: false,
  error: null as Error | null,
  setSelectedCompanyId: () => {},
  reloadCompanies: async () => {},
  createCompany: async () => ({ id: COMPANY_ID, name: "PAP-11227 QA Co" } as never),
};

export function useCompany() {
  return companyContextValue;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function resolveBootstrapCompanySelection() {
  return COMPANY_ID;
}

export function shouldClearStoredCompanySelection() {
  return false;
}
