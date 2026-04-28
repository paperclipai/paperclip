import { api } from "./client";

export type Rt2TeamHealth = {
  collaborationScore: number;
  activeContributors: number;
  blockedTasks: number;
  averageTaskCompletionHours: number;
};

export type Rt2WorkloadBalance = {
  userId: string;
  activeTasks: number;
  workloadPercent: number;
};

export type Rt2QualityMetrics = {
  defectRate: number;
  codeReviewCoverage: number;
  reviewCycleTime: number | null;
  qualityScore: number;
};

export type Rt2QualityTrendPoint = {
  date: string;
  defectRate: number;
  reviewCoverage: number;
  totalDeliverables: number;
};

export type Rt2QualityTrendsResponse = {
  companyId: string;
  projectId: string;
  dataPoints: Rt2QualityTrendPoint[];
  trend: "improving" | "stable" | "declining";
};

export type Rt2QualityGate = {
  id: string;
  name: string;
  status: "passing" | "failing" | "warning";
  threshold: number;
  currentValue: number;
};

export type Rt2QualityGatesResponse = {
  companyId: string;
  projectId: string;
  gates: Rt2QualityGate[];
  overallPassing: boolean;
};

export const rt2CollaborationApi = {
  getTeamHealth: (companyId: string, projectId: string) =>
    api.get<Rt2TeamHealth>(`/companies/${companyId}/rt2/collaboration/health?projectId=${encodeURIComponent(projectId)}`),
  getWorkloadBalance: (companyId: string, projectId: string) =>
    api.get<Rt2WorkloadBalance[]>(`/companies/${companyId}/rt2/collaboration/workload?projectId=${encodeURIComponent(projectId)}`),
  getQualityMetrics: (companyId: string, projectId: string) =>
    api.get<Rt2QualityMetrics>(`/companies/${companyId}/rt2/quality/metrics?projectId=${encodeURIComponent(projectId)}`),
  getQualityTrends: (companyId: string, projectId: string) =>
    api.get<Rt2QualityTrendsResponse>(`/companies/${companyId}/rt2/quality/trends?projectId=${encodeURIComponent(projectId)}`),
  getQualityGates: (companyId: string, projectId: string) =>
    api.get<Rt2QualityGatesResponse>(`/companies/${companyId}/rt2/quality/gates?projectId=${encodeURIComponent(projectId)}`),
};
