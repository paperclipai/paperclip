import { api } from "./client";

export interface ReviewPipelineTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  stages: Array<{ label: string; reviewerAgentId?: string; reviewerUserId?: string; role?: string }>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectReviewDefault {
  projectId: string;
  companyId: string;
  reviewPipelineTemplateId: string;
  createdAt: string;
  updatedAt: string;
}

export const reviewTemplatesApi = {
  list: (companyId: string) =>
    api.get<ReviewPipelineTemplate[]>(`/companies/${companyId}/review-templates`),
  create: (companyId: string, data: { name: string; description?: string; stages: unknown[]; isDefault?: boolean }) =>
    api.post<ReviewPipelineTemplate>(`/companies/${companyId}/review-templates`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<ReviewPipelineTemplate>(`/review-templates/${id}`, data),
  remove: (id: string) =>
    api.delete<void>(`/review-templates/${id}`),
  seed: (companyId: string) =>
    api.post<{ seeded: number; templates: ReviewPipelineTemplate[] }>(`/companies/${companyId}/review-templates/seed`, {}),
  getProjectDefault: (projectId: string) =>
    api.get<ProjectReviewDefault>(`/projects/${projectId}/review-defaults`),
  setProjectDefault: (projectId: string, data: { companyId: string; reviewPipelineTemplateId: string }) =>
    api.put<ProjectReviewDefault>(`/projects/${projectId}/review-defaults`, data),
};
