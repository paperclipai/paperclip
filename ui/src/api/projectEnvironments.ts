import { api } from "./client";

export interface ProjectEnvironment {
  id: string;
  companyId: string;
  projectId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  config: {
    github?: { owner: string; repo: string; baseBranch: string; webhookSecret?: string };
    deploy?: { url?: string; healthEndpoint?: string };
    merge?: { method?: string; deleteSourceBranch?: boolean };
  };
  createdAt: string;
  updatedAt: string;
}

export const projectEnvironmentsApi = {
  list: (companyId: string, projectId: string) =>
    api.get<ProjectEnvironment[]>(`/companies/${companyId}/projects/${projectId}/environments`),
  create: (companyId: string, projectId: string, data: Record<string, unknown>) =>
    api.post<ProjectEnvironment>(`/companies/${companyId}/projects/${projectId}/environments`, data),
  update: (companyId: string, projectId: string, envId: string, data: Record<string, unknown>) =>
    api.put<ProjectEnvironment>(`/companies/${companyId}/projects/${projectId}/environments/${envId}`, data),
  remove: (companyId: string, projectId: string, envId: string) =>
    api.delete(`/companies/${companyId}/projects/${projectId}/environments/${envId}`),
};
