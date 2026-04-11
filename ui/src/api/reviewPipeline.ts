import { api } from "./client";

export interface ReviewCheck {
  id: string;
  reviewRunId: string;
  stepSlug: string;
  stepName: string;
  stepType: string;
  executor: string;
  status: string;
  summary: string | null;
  details: Record<string, unknown> | null;
  checkedAt: string | null;
  createdAt: string;
}

export interface ReviewRun {
  id: string;
  companyId: string;
  workProductId: string;
  issueId: string;
  pipelineTemplateId: string;
  status: string;
  triggeredBy: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  checks: ReviewCheck[];
}

export interface ReviewPipelineTemplate {
  id: string;
  companyId: string;
  teamId: string | null;
  name: string;
  isDefault: boolean;
  enabled: boolean;
  steps: Array<{
    slug: string;
    name: string;
    type: string;
    executor: string;
    config?: Record<string, unknown>;
  }>;
  createdAt: string;
  updatedAt: string;
}

export const reviewPipelineApi = {
  getTeamPipeline: (companyId: string, teamId: string) =>
    api.get<ReviewPipelineTemplate | null>(`/companies/${companyId}/teams/${teamId}/review-pipeline`),
  updateTeamPipeline: (companyId: string, teamId: string, data: Record<string, unknown>) =>
    api.put<ReviewPipelineTemplate>(`/companies/${companyId}/teams/${teamId}/review-pipeline`, data),
  getIssueReviews: (companyId: string, issueId: string) =>
    api.get<ReviewRun[]>(`/companies/${companyId}/issues/${issueId}/reviews`),
  approveRun: (companyId: string, issueId: string, runId: string) =>
    api.post(`/companies/${companyId}/issues/${issueId}/reviews/${runId}/approve`, {}),
  rejectRun: (companyId: string, issueId: string, runId: string, decisionNote: string) =>
    api.post(`/companies/${companyId}/issues/${issueId}/reviews/${runId}/reject`, { decisionNote }),
  updateCheck: (companyId: string, runId: string, checkId: string, data: Record<string, unknown>) =>
    api.put(`/companies/${companyId}/reviews/${runId}/checks/${checkId}`, data),
};
