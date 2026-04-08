import type {
  CostSummary,
  CostByAgent,
  CostByProviderModel,
  CostByBiller,
  CostByAgentModel,
  CostByAgentDaily,
  CostByProject,
  CostWindowSpendRow,
  FinanceSummary,
  FinanceByBiller,
  FinanceByKind,
  FinanceEvent,
  ProviderQuotaResult,
} from "@paperclipai/shared";
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
  byAgentModel: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgentModel[]>(`/companies/${companyId}/costs/by-agent-model${dateParams(from, to)}`),
  byAgentDaily: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgentDaily[]>(`/companies/${companyId}/costs/by-agent-daily${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  byProvider: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProviderModel[]>(`/companies/${companyId}/costs/by-provider${dateParams(from, to)}`),
  byBiller: (companyId: string, from?: string, to?: string) =>
    api.get<CostByBiller[]>(`/companies/${companyId}/costs/by-biller${dateParams(from, to)}`),
  financeSummary: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceSummary>(`/companies/${companyId}/costs/finance-summary${dateParams(from, to)}`),
  financeByBiller: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByBiller[]>(`/companies/${companyId}/costs/finance-by-biller${dateParams(from, to)}`),
  financeByKind: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByKind[]>(`/companies/${companyId}/costs/finance-by-kind${dateParams(from, to)}`),
  financeEvents: (companyId: string, from?: string, to?: string, limit: number = 100) =>
    api.get<FinanceEvent[]>(`/companies/${companyId}/costs/finance-events${dateParamsWithLimit(from, to, limit)}`),
  windowSpend: (companyId: string) =>
    api.get<CostWindowSpendRow[]>(`/companies/${companyId}/costs/window-spend`),
  quotaWindows: (companyId: string) =>
    api.get<ProviderQuotaResult[]>(`/companies/${companyId}/costs/quota-windows`),
};

function dateParamsWithLimit(from?: string, to?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
