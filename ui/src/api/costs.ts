import type { CostSummary, CostByAgent, CostTrend, CostForecast, CostEfficiencyAgent } from "@paperclipai/shared";
import { api } from "./client";

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/companies/${companyId}/costs/summary${dateParams(from, to)}`),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/companies/${companyId}/costs/by-agent${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  trend: (companyId: string, from?: string, to?: string) =>
    api.get<CostTrend>(`/companies/${companyId}/costs/trend${dateParams(from, to)}`),
  forecast: (companyId: string) =>
    api.get<CostForecast>(`/companies/${companyId}/costs/forecast`),
  efficiency: (companyId: string, from?: string, to?: string) =>
    api.get<CostEfficiencyAgent[]>(`/companies/${companyId}/costs/efficiency${dateParams(from, to)}`),
};
