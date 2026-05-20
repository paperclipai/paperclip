import type { DashboardSummary, DashboardTokenUsage, DashboardTokenUsageRange } from "@paperclipai/shared";
import { api } from "./client";

type TokenUsageQuery = {
  range: DashboardTokenUsageRange;
  agentId?: string | null;
};

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  tokenUsage: (companyId: string, query: TokenUsageQuery) => {
    const params = new URLSearchParams();
    params.set("range", query.range);
    if (query.agentId) params.set("agentId", query.agentId);
    return api.get<DashboardTokenUsage>(`/companies/${companyId}/dashboard/token-usage?${params.toString()}`);
  },
};
