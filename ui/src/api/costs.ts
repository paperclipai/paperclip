import type { CostSummary, CostByAgent, CostByProject } from "@paperclipai/shared";
import { api } from "./client";

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
};
