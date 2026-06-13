import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

// Local mirror of the server's AgentScorecardsResult contract
// (server/src/services/agent-scorecards.ts). Kept local to avoid a
// cross-package build dependency on @paperclipai/shared for this additive
// feature; hoist into shared if a third consumer appears.
export interface AgentScorecard {
  agentId: string;
  agentName: string;
  status: string;
  doneIssues: number;
  costUsd: number;
  costPerDoneIssue: number | null;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  failureRate: number | null;
  reviewedIssues: number;
  passedReviews: number;
  reviewPassRate: number | null;
  lowSample: boolean;
  perMetricSufficient: {
    costPerDoneIssue: boolean;
    failureRate: boolean;
    reviewPassRate: boolean;
  };
}

export interface AgentScorecardsResult {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  minSampleDone: number;
  minSampleRuns: number;
  minSampleReviews: number;
  agents: AgentScorecard[];
}

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  agentScorecards: (companyId: string, windowDays?: number) =>
    api.get<AgentScorecardsResult>(
      `/companies/${companyId}/agent-scorecards${windowDays ? `?windowDays=${windowDays}` : ""}`,
    ),
};
