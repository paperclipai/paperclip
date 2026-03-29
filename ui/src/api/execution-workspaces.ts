import type { EnrichedExecutionWorkspace, ExecutionWorkspace } from "@paperclipai/shared";
import { api } from "./client";

export type GitWorktreeEntry = {
  path: string;
  head: string;
  branch: string | null;
  isMainWorktree: boolean;
  executionWorkspace: ExecutionWorkspace | null;
  issue: { id: string; title: string; identifier: string | null; status: string } | null;
  agent: { id: string; name: string } | null;
};

export const executionWorkspacesApi = {
  list: (
    companyId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<ExecutionWorkspace[]>(`/companies/${companyId}/execution-workspaces${qs ? `?${qs}` : ""}`);
  },
  listEnriched: (
    companyId: string,
    filters?: {
      projectId?: string;
      status?: string;
    },
  ) => {
    const params = new URLSearchParams({ enriched: "true" });
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.status) params.set("status", filters.status);
    return api.get<EnrichedExecutionWorkspace[]>(`/companies/${companyId}/execution-workspaces?${params.toString()}`);
  },
  listGitWorktrees: (companyId: string, projectId: string) =>
    api.get<GitWorktreeEntry[]>(`/companies/${companyId}/projects/${projectId}/git-worktrees`),
  removeGitWorktree: (companyId: string, projectId: string, path: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/projects/${projectId}/git-worktrees/remove`, { path }),
  get: (id: string) => api.get<ExecutionWorkspace>(`/execution-workspaces/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<ExecutionWorkspace>(`/execution-workspaces/${id}`, data),
};
