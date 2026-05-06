import type {
  Project,
  ProjectWorkProduct,
  ProjectWorkspace,
  WorkspaceFileBrowserContent,
  WorkspaceFileBrowserListing,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

const API_BASE = "/api";

export interface ProjectIntegrationStatus {
  github: {
    connected: boolean;
    repoUrl: string | null;
    repoName: string | null;
    rootPath: string;
    localPathAvailable: boolean;
    isGitCheckout: boolean;
    branch: string | null;
    commitSha: string | null;
    remoteUrl: string | null;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    dirty: boolean | null;
    synced: boolean;
    status: string;
    message: string;
  };
  vercel: {
    deployed: boolean;
    latestDeployment: ProjectWorkProduct | null;
    deploymentCount: number;
    hasToken: boolean;
    status: string;
    message: string;
  };
}

export interface ProjectActionResult {
  action?: string;
  stdout: string;
  stderr: string;
  deploymentUrl?: string | null;
  github?: ProjectIntegrationStatus["github"];
  vercel?: ProjectIntegrationStatus["vercel"];
}

function withCompanyScope(path: string, companyId?: string) {
  if (!companyId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}companyId=${encodeURIComponent(companyId)}`;
}

function withRelativePath(path: string, relativePath?: string) {
  if (!relativePath) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}path=${encodeURIComponent(relativePath)}`;
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
  listWorkProducts: (projectId: string, companyId?: string) =>
    api.get<ProjectWorkProduct[]>(projectPath(projectId, companyId, "/work-products")),
  getIntegrationStatus: (projectId: string, companyId?: string) =>
    api.get<ProjectIntegrationStatus>(projectPath(projectId, companyId, "/integration-status")),
  runGithubAction: (projectId: string, action: "pull" | "push" | "sync-progress", companyId?: string) =>
    api.post<ProjectActionResult>(projectPath(projectId, companyId, `/github/${action}`), {}),
  deployToVercel: (projectId: string, data: { production?: boolean } = {}, companyId?: string) =>
    api.post<ProjectActionResult>(projectPath(projectId, companyId, "/vercel/deploy"), data),
  listCodebaseFiles: (projectId: string, relativePath = "", companyId?: string) =>
    api.get<WorkspaceFileBrowserListing>(
      withRelativePath(projectPath(projectId, companyId, "/codebase/files"), relativePath),
    ),
  getCodebaseFileContent: (projectId: string, relativePath: string, companyId?: string) =>
    api.get<WorkspaceFileBrowserContent>(
      withRelativePath(projectPath(projectId, companyId, "/codebase/file-content"), relativePath),
    ),
  codebaseFileRawPath: (projectId: string, relativePath: string, companyId?: string) =>
    `${API_BASE}${withRelativePath(projectPath(projectId, companyId, "/codebase/file-raw"), relativePath)}`,
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
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  controlWorkspaceCommands: (
    projectId: string,
    workspaceId: string,
    action: "start" | "stop" | "restart" | "run",
    companyId?: string,
    target: WorkspaceRuntimeControlTarget = {},
  ) =>
    api.post<{ workspace: ProjectWorkspace; operation: WorkspaceOperation }>(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/runtime-commands/${action}`),
      sanitizeWorkspaceRuntimeControlTarget(target),
    ),
  listWorkspaceFiles: (projectId: string, workspaceId: string, relativePath = "", companyId?: string) =>
    api.get<WorkspaceFileBrowserListing>(
      withRelativePath(
        projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/files`),
        relativePath,
      ),
    ),
  getWorkspaceFileContent: (projectId: string, workspaceId: string, relativePath: string, companyId?: string) =>
    api.get<WorkspaceFileBrowserContent>(
      withRelativePath(
        projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/file-content`),
        relativePath,
      ),
    ),
  workspaceFileRawPath: (projectId: string, workspaceId: string, relativePath: string, companyId?: string) =>
    `${API_BASE}${withRelativePath(
      projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}/file-raw`),
      relativePath,
    )}`,
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
};
