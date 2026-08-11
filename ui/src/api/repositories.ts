import type {
  AgentRepositoryGrantEntry,
  BeginRepositoryConnectionResult,
  CompleteRepositoryConnectionResult,
  CreateManualRepository,
  CreateRepositoryConnection,
  EffectiveRepositoryAccess,
  ImportRepositoriesResult,
  ProjectRepositoryEntry,
  Repository,
  RepositoryCatalogItem,
  RepositoryConnection,
  RepositoryDiscoveryPage,
  UpdateRepository,
} from "@paperclipai/shared";
import { api } from "./client";

export interface RepositoryCloneCredential {
  username: string;
  token: string;
  authenticatedCloneUrl: string;
  expiresAt: string;
}

export interface RepositoryDiscoveryQuery {
  query?: string | null;
  cursor?: string | null;
  pageSize?: number;
}

function discoveryQueryString(opts: RepositoryDiscoveryQuery = {}): string {
  const params = new URLSearchParams();
  if (opts.query) params.set("query", opts.query);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (typeof opts.pageSize === "number") params.set("pageSize", String(opts.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const repositoriesApi = {
  list: (companyId: string, opts: { includeArchived?: boolean } = {}) =>
    api.get<RepositoryCatalogItem[]>(
      `/companies/${encodeURIComponent(companyId)}/repositories${opts.includeArchived ? "?includeArchived=true" : ""}`,
    ),
  get: (repositoryId: string) => api.get<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`),
  createManual: (companyId: string, input: CreateManualRepository) =>
    api.post<Repository>(`/companies/${encodeURIComponent(companyId)}/repositories`, input),
  update: (repositoryId: string, input: UpdateRepository) =>
    api.patch<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`, input),
  archive: (repositoryId: string) =>
    api.delete<Repository>(`/repositories/${encodeURIComponent(repositoryId)}`),

  listConnections: (companyId: string) =>
    api.get<RepositoryConnection[]>(`/companies/${encodeURIComponent(companyId)}/repository-connections`),
  getConnection: (connectionId: string) =>
    api.get<RepositoryConnection>(`/repository-connections/${encodeURIComponent(connectionId)}`),
  createConnection: (companyId: string, input: CreateRepositoryConnection) =>
    api.post<RepositoryConnection>(
      `/companies/${encodeURIComponent(companyId)}/repository-connections`,
      input,
    ),
  syncConnection: (connectionId: string) =>
    api.post<{ connection: RepositoryConnection; repositories: Repository[] }>(
      `/repository-connections/${encodeURIComponent(connectionId)}/sync`,
      {},
    ),
  disconnectConnection: (connectionId: string) =>
    api.delete<{ connection: RepositoryConnection; repositories: Repository[] }>(
      `/repository-connections/${encodeURIComponent(connectionId)}`,
    ),

  // ---- Guided provider connection flow (GitHub.com + other providers) ----
  beginConnection: (companyId: string, provider: string, input: { redirectPath?: string | null } = {}) =>
    api.post<BeginRepositoryConnectionResult>(
      `/companies/${encodeURIComponent(companyId)}/repository-connections/${encodeURIComponent(provider)}/install`,
      input,
    ),
  completeConnection: (
    companyId: string,
    provider: string,
    input: { state: string; installationId: string },
  ) =>
    api.post<CompleteRepositoryConnectionResult>(
      `/companies/${encodeURIComponent(companyId)}/repository-connections/${encodeURIComponent(provider)}/callback`,
      input,
    ),
  discoverConnectionRepositories: (connectionId: string, opts: RepositoryDiscoveryQuery = {}) =>
    api.get<RepositoryDiscoveryPage>(
      `/repository-connections/${encodeURIComponent(connectionId)}/discover${discoveryQueryString(opts)}`,
    ),
  importConnectionRepositories: (connectionId: string, providerRepositoryIds: string[]) =>
    api.post<ImportRepositoriesResult>(
      `/repository-connections/${encodeURIComponent(connectionId)}/import`,
      { providerRepositoryIds },
    ),
  resolveCloneCredential: (repositoryId: string) =>
    api.post<RepositoryCloneCredential>(
      `/repositories/${encodeURIComponent(repositoryId)}/clone-credential`,
      {},
    ),

  listProjectRepositories: (projectId: string) =>
    api.get<ProjectRepositoryEntry[]>(`/projects/${encodeURIComponent(projectId)}/repositories`),
  attachProjectRepository: (projectId: string, repositoryId: string, displayOrder = 0) =>
    api.put<ProjectRepositoryEntry>(
      `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
      { displayOrder },
    ),
  detachProjectRepository: (projectId: string, repositoryId: string) =>
    api.delete<{ removed: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`,
    ),

  listDirectAgentGrants: (agentId: string) =>
    api.get<AgentRepositoryGrantEntry[]>(`/agents/${encodeURIComponent(agentId)}/repositories`),
  listEffectiveAgentRepositories: (agentId: string) =>
    api.get<EffectiveRepositoryAccess[]>(`/agents/${encodeURIComponent(agentId)}/repositories?effective=true`),
  grantAgentRepository: (agentId: string, repositoryId: string) =>
    api.put<AgentRepositoryGrantEntry>(
      `/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
      {},
    ),
  revokeAgentRepository: (agentId: string, repositoryId: string) =>
    api.delete<{ removed: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/repositories/${encodeURIComponent(repositoryId)}`,
    ),
};
