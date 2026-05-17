import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

type HeartbeatRunStaleness = {
  thresholdMs: number;
  staleAgentCount: number;
  totalStaleRunCount: number;
  agents: Array<{
    agentId: string;
    agentName: string;
    lastHeartbeatAt: string | null;
    staleRunCount: number;
  }>;
};

type DashboardSummaryWire = DashboardSummary & {
  heartbeatRunStaleness?: HeartbeatRunStaleness;
};

export type NormalizedDashboardSummary = DashboardSummary & {
  heartbeatRunStaleness: HeartbeatRunStaleness;
};

const emptyHeartbeatRunStaleness: HeartbeatRunStaleness = {
  thresholdMs: 0,
  staleAgentCount: 0,
  totalStaleRunCount: 0,
  agents: [],
};

export function normalizeDashboardSummary(summary: DashboardSummaryWire): NormalizedDashboardSummary {
  return {
    ...summary,
    heartbeatRunStaleness: summary.heartbeatRunStaleness ?? emptyHeartbeatRunStaleness,
  };
}

export const dashboardApi = {
  summary: async (companyId: string) =>
    normalizeDashboardSummary(await api.get<DashboardSummaryWire>(`/companies/${companyId}/dashboard`)),
};
