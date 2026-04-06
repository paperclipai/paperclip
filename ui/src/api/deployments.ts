import { api } from "./client";

export interface Deployment {
  id: string;
  companyId: string;
  projectId: string | null;
  agentId: string | null;
  runId: string | null;
  environment: string;
  status: string;
  url: string | null;
  provider: string | null;
  deployLog: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Cloud deployment fields
  cloudProvider: string | null;
  cloudRegion: string | null;
  cloudResourceId: string | null;
  cloudResourceType: string | null;
  cloudConfig: Record<string, unknown>;
  healthStatus: string | null;
  healthCheckedAt: string | null;
  healthMessage: string | null;
  rollbackDeploymentId: string | null;
  version: string | null;
  commitSha: string | null;
  dockerImage: string | null;
  domain: string | null;
  sslEnabled: boolean;
}

export const deploymentsApi = {
  list: (companyId: string) =>
    api.get<Deployment[]>(`/companies/${companyId}/deployments`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Deployment>(`/companies/${companyId}/deployments`, data),
  update: (companyId: string, id: string, data: Record<string, unknown>) =>
    api.patch<Deployment>(`/companies/${companyId}/deployments/${id}`, data),
};
