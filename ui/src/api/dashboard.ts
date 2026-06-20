import type { CeoControlRoomStatus, DashboardSummary, MicroRegistryOverview } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  ceoControlRoom: (companyId: string) => api.get<CeoControlRoomStatus>(`/companies/${companyId}/ceo-control-room`),
  microRegistry: (companyId: string) => api.get<MicroRegistryOverview>(`/companies/${companyId}/micro-registry`),
};
