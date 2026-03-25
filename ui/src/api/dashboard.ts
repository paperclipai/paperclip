import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

export interface DashboardRun {
  id: string;
  agentId: string;
  agentName: string | null;
  issueId: string | null;
  issueTitle: string | null;
  issueIdentifier: string | null;
  status: string;
  invocationSource: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface DashboardRunStats {
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  runs: (companyId: string) => api.get<DashboardRun[]>(`/companies/${companyId}/dashboard/runs`),
  runStats: (companyId: string) =>
    api.get<DashboardRunStats>(`/companies/${companyId}/dashboard/run-stats`),
};
