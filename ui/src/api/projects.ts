import type {
  GitCommitResult,
  GitDiffResponse,
  GitPushResult,
  GitStatusResponse,
  Project,
  ProjectFileDetail,
  ProjectFilesBranchSyncResult,
  ProjectFilesSummary,
  ProjectFilesSyncResult,
  ProjectFilesTreeResponse,
  ProjectWorkspace,
  WorkspaceOperation,
} from "@paperclipai/shared";
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
  filesSummary: (projectId: string, companyId?: string) =>
    api.get<ProjectFilesSummary>(projectPath(projectId, companyId, "/files")),
  filesTree: (projectId: string, params?: { path?: string; showIgnored?: boolean; companyId?: string }) => {
    const search = new URLSearchParams();
    if (params?.path) search.set("path", params.path);
    if (params?.showIgnored) search.set("showIgnored", "true");
    const suffix = `/files/tree${search.size > 0 ? `?${search.toString()}` : ""}`;
    return api.get<ProjectFilesTreeResponse>(projectPath(projectId, params?.companyId, suffix));
  },
  fileContent: (projectId: string, relativePath: string, companyId?: string) =>
    api.get<ProjectFileDetail>(
      projectPath(projectId, companyId, `/files/content?path=${encodeURIComponent(relativePath)}`),
    ),
  saveFileContent: (projectId: string, data: { path: string; content: string }, companyId?: string) =>
    api.put<ProjectFileDetail>(projectPath(projectId, companyId, "/files/content"), data),
  createFile: (projectId: string, data: { path: string }, companyId?: string) =>
    api.post<ProjectFileDetail>(projectPath(projectId, companyId, "/files/tree/file"), data),
  createFolder: (projectId: string, data: { path: string }, companyId?: string) =>
    api.post<{ path: string }>(projectPath(projectId, companyId, "/files/tree/folder"), data),
  renamePath: (projectId: string, data: { path: string; nextPath: string }, companyId?: string) =>
    api.patch<{ path: string }>(projectPath(projectId, companyId, "/files/tree"), data),
  deletePath: (projectId: string, relativePath: string, companyId?: string) =>
    api.delete<{ path: string }>(projectPath(projectId, companyId, `/files/tree?path=${encodeURIComponent(relativePath)}`)),
  switchBranch: (
    projectId: string,
    data: { branch: string; mode?: "default" | "autostash" | "discard" },
    companyId?: string,
  ) => api.post<ProjectFilesSummary>(projectPath(projectId, companyId, "/files/branch"), data),
  createBranch: (
    projectId: string,
    data: { name: string; startPoint?: string | null },
    companyId?: string,
  ) => api.post<ProjectFilesSummary>(projectPath(projectId, companyId, "/files/branch/create"), data),
  syncFiles: (projectId: string, companyId?: string) =>
    api.post<ProjectFilesSyncResult>(projectPath(projectId, companyId, "/files/sync"), {}),
  syncBranches: (projectId: string, companyId?: string) =>
    api.post<ProjectFilesBranchSyncResult>(projectPath(projectId, companyId, "/files/branches/sync"), {}),
  deleteBranch: (projectId: string, name: string, force = false, companyId?: string) =>
    api.delete<ProjectFilesSummary>(projectPath(projectId, companyId, `/files/branch?name=${encodeURIComponent(name)}${force ? "&force=true" : ""}`)),
  publishToRemote: (projectId: string, remoteUrl: string, companyId?: string) =>
    api.post<{ status: string; message: string | null }>(
      projectPath(projectId, companyId, "/files/publish-remote"),
      { remoteUrl },
    ),
  gitStatus: (projectId: string, companyId?: string) =>
    api.get<GitStatusResponse>(projectPath(projectId, companyId, "/files/git-status")),
  stageFiles: (projectId: string, data: { paths: string[] }, companyId?: string) =>
    api.post<GitStatusResponse>(projectPath(projectId, companyId, "/files/git-stage"), data),
  unstageFiles: (projectId: string, data: { paths: string[] }, companyId?: string) =>
    api.post<GitStatusResponse>(projectPath(projectId, companyId, "/files/git-unstage"), data),
  commitStaged: (projectId: string, data: { message: string }, companyId?: string) =>
    api.post<GitCommitResult>(projectPath(projectId, companyId, "/files/git-commit"), data),
  fileDiff: (projectId: string, filePath: string, staged: boolean, companyId?: string) =>
    api.get<GitDiffResponse>(
      projectPath(projectId, companyId, `/files/git-diff?path=${encodeURIComponent(filePath)}${staged ? "&staged=true" : ""}`),
    ),
  discardFiles: (projectId: string, data: { paths: string[] }, companyId?: string) =>
    api.post<GitStatusResponse>(projectPath(projectId, companyId, "/files/git-discard"), data),
  pushFiles: (projectId: string, companyId?: string) =>
    api.post<GitPushResult>(projectPath(projectId, companyId, "/files/git-push"), {}),
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
};
