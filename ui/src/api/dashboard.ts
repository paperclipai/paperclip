import type { DashboardSummary, OperationsPulse } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  operationsPulse: (companyId: string) =>
    api.get<OperationsPulse>(`/companies/${companyId}/operations/pulse`),
};
