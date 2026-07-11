import type { CompanyGithubConnection, GithubConnectionTestResult } from "@paperclipai/shared";
import { api } from "./client";

export const githubConnectionsApi = {
  list: (companyId: string) =>
    api.get<CompanyGithubConnection[]>(`/companies/${encodeURIComponent(companyId)}/github-connections`),
  create: (companyId: string, payload: { name: string; hostname: string; secretId: string; enabled?: boolean }) =>
    api.post<CompanyGithubConnection>(`/companies/${encodeURIComponent(companyId)}/github-connections`, payload),
  update: (companyId: string, connectionId: string, payload: { name?: string; hostname?: string; secretId?: string; enabled?: boolean }) =>
    api.patch<CompanyGithubConnection>(`/companies/${encodeURIComponent(companyId)}/github-connections/${encodeURIComponent(connectionId)}`, payload),
  test: (companyId: string, connectionId: string) =>
    api.post<GithubConnectionTestResult>(`/companies/${encodeURIComponent(companyId)}/github-connections/${encodeURIComponent(connectionId)}/test`, {}),
  remove: (companyId: string, connectionId: string) =>
    api.delete<{ success: true }>(`/companies/${encodeURIComponent(companyId)}/github-connections/${encodeURIComponent(connectionId)}`),
};
