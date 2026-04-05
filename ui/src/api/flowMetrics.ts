import { api } from "./client";

export interface FlowMetrics {
  avgCycleTimeMinutes: number;
  avgLeadTimeMinutes: number;
  throughputPerWeek: number;
  throughputTrend: "improving" | "stable" | "declining";
  bottleneckColumn: string | null;
  bottleneckCount: number;
  blockedIssues: number;
  avgBlockedDurationMinutes: number;
}

export const flowMetricsApi = {
  get: (companyId: string) =>
    api.get<FlowMetrics>(`/companies/${companyId}/flow-metrics`),
};
