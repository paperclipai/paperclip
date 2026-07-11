import { api } from "./client";

export type CompanyAuthenticator = {
  id: string;
  companyId: string;
  name: string;
  issuer: string | null;
  accountName: string | null;
  agentIds: string[];
  createdAt: string;
  updatedAt: string;
};

export const authenticatorsApi = {
  list: (companyId: string) => api.get<CompanyAuthenticator[]>(`/companies/${companyId}/authenticators`),
  create: (companyId: string, input: { name: string; secret: string; issuer?: string; accountName?: string; agentIds: string[] }) =>
    api.post<CompanyAuthenticator>(`/companies/${companyId}/authenticators`, input),
  bindAgents: (id: string, agentIds: string[]) => api.put<{ ok: true; agentIds: string[] }>(`/authenticators/${id}/agents`, { agentIds }),
  currentCode: (id: string, input?: { issueId?: string; runId?: string }) => api.post<{ code: string; expiresAt: string }>(`/authenticators/${id}/code`, input ?? {}),
};
