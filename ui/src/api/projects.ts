import type { Project, ProjectWorkspace, WorkspaceOperation } from "@paperclipai/shared";
import { api } from "./client";

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function projectPath(id: string, companyId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, companyId);
}

export const projectsApi = {
  list: (companyId: string) => api.get<Project[]>(`/companies/${companyId}/projects`),
  get: (id: string, companyId?: string) => api.get<Project>(projectPath(id, companyId)),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Project>(`/companies/${companyId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<Project>(projectPath(id, companyId), data),
  listWorkspaces: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkspace[]>(projectPath(projectId, companyId, "/workspaces")),
  createWorkspace: (projectId: string, data: Record<string, unknown>, companyId?: string) =>
    api.post<ProjectWorkspace>(projectPath(projectId, companyId, "/workspaces"), data),
  updateWorkspace: (projectId: string, workspaceId: string, data: Record<string, unknown>, companyId?: string) =>
    api.patch<ProjectWorkspace>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`),
      data,
    ),
  controlWorkspaceRuntimeServices: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart",
    companyId?: string,
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      {},
    ),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),

  // ── Git operations ────────────────────────────────────────────────
  getWorkspaceGitInfo: (workspaceId: string) =>
    api.get<{ branch: string | null; dirty: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-info`),
  getWorkspaceGitStatus: (workspaceId: string) =>
    api.get<{ staged: GitStatusFile[]; unstaged: GitStatusFile[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-status`),
  getWorkspaceGitDiff: (workspaceId: string, path: string, staged: boolean) =>
    api.get<{ diff: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-diff?path=${encodeURIComponent(path)}&staged=${staged}`),
  stageFiles: (workspaceId: string, paths: string[]) =>
    api.post<{ ok: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-stage`, { paths }),
  unstageFiles: (workspaceId: string, paths: string[]) =>
    api.post<{ ok: boolean }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-unstage`, { paths }),
  commitChanges: (workspaceId: string, message: string) =>
    api.post<{ ok: boolean; summary: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/git-commit`, { message }),

  // ── File browser ──────────────────────────────────────────────────
  listFiles: (workspaceId: string, path?: string) =>
    api.get<FileListResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),

  // ── PR status ─────────────────────────────────────────────────────
  getPrStatus: (workspaceId: string) =>
    api.get<PrStatusResponse>(`/workspaces/${encodeURIComponent(workspaceId)}/pr-status`),
};

interface GitStatusFile { path: string; status: string }

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface FileListResponse {
  path: string;
  files: FileEntry[];
}

export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  reviewDecision: string | null;
  body: string;
}

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface PrStatusResponse {
  branch: string;
  pr: PrInfo | null;
  checks: CiCheck[];
  error?: string;
}
