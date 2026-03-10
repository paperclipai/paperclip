import type { CompanyCronJob } from "@paperclipai/shared";
import { api } from "./client";

export const cronJobsApi = {
  list: (companyId: string, filters?: { agentId?: string; enabled?: string }) => {
    const params = new URLSearchParams();
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.enabled) params.set("enabled", filters.enabled);
    const qs = params.toString();
    return api.get<CompanyCronJob[]>(`/companies/${companyId}/cron-jobs${qs ? `?${qs}` : ""}`);
  },
  get: (companyId: string, id: string) =>
    api.get<CompanyCronJob>(`/companies/${companyId}/cron-jobs/${id}`),
  create: (companyId: string, data: {
    agentId: string;
    name: string;
    description?: string | null;
    enabled?: boolean;
    cronExpr: string;
    timezone?: string;
    staggerMs?: number;
    payload?: Record<string, unknown>;
  }) => api.post<CompanyCronJob>(`/companies/${companyId}/cron-jobs`, data),
  update: (companyId: string, id: string, data: {
    name?: string;
    description?: string | null;
    enabled?: boolean;
    cronExpr?: string;
    timezone?: string;
    staggerMs?: number;
    payload?: Record<string, unknown>;
  }) => api.patch<CompanyCronJob>(`/companies/${companyId}/cron-jobs/${id}`, data),
  remove: (companyId: string, id: string) =>
    api.delete<void>(`/companies/${companyId}/cron-jobs/${id}`),
  trigger: (companyId: string, id: string) =>
    api.post<{ triggered: boolean; runId: string | null }>(`/companies/${companyId}/cron-jobs/${id}/run`, {}),
};
