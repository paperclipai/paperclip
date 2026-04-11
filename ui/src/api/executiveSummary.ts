import type { CompanyKpi, CompanyKpiInput, ExecutiveSummary } from "@paperclipai/shared";
import { api } from "./client";

export const executiveSummaryApi = {
  getSummary: (companyId: string) =>
    api.get<ExecutiveSummary>(`/companies/${companyId}/executive-summary`),
  listKpis: (companyId: string) =>
    api.get<CompanyKpi[]>(`/companies/${companyId}/kpis`),
  replaceKpis: (companyId: string, kpis: CompanyKpiInput[]) =>
    api.put<CompanyKpi[]>(`/companies/${companyId}/kpis`, { kpis }),
};
