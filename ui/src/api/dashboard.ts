import type { BacklogHealthSummary, DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

type DashboardSummaryWire = Omit<DashboardSummary, "heartbeatRunStaleness"> & {
  heartbeatRunStaleness?: DashboardSummary["heartbeatRunStaleness"];
};

const emptyHeartbeatRunStaleness: DashboardSummary["heartbeatRunStaleness"] = {
  thresholdMs: 0,
  staleAgentCount: 0,
  totalStaleRunCount: 0,
  agents: [],
};

export function normalizeDashboardSummary(summary: DashboardSummaryWire): DashboardSummary {
  return {
    ...summary,
    heartbeatRunStaleness: summary.heartbeatRunStaleness ?? emptyHeartbeatRunStaleness,
  };
}

export const dashboardApi = {
  summary: async (companyId: string) =>
    normalizeDashboardSummary(await api.get<DashboardSummaryWire>(`/companies/${companyId}/dashboard`)),
  backlogHealth: (companyId: string) =>
    api.get<BacklogHealthSummary>(`/companies/${companyId}/dashboard/backlog-health`),
};
