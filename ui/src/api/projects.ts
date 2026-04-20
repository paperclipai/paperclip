import type {
  Project,
  ProjectWorkspace,
  WorkspaceOperation,
  WorkspaceRuntimeControlTarget,
} from "@paperclipai/shared";
import { api } from "./client";
import { sanitizeWorkspaceRuntimeControlTarget } from "./workspace-runtime-control";

export interface ProjectMember {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  role: string;
  displayName: string;
  email: string | null;
  grants: Array<{ permissionKey: string }>;
  createdAt: string;
}

export interface ProjectAgentAccess {
  id: string;
  projectId: string;
  agentId: string;
  agent: { id: string; name: string; role: string; iconName: string | null };
  createdAt: string;
}

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
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),

  listMembers: (projectId: string) =>
    api.get<ProjectMember[]>(`/projects/${projectId}/members`),

  addMember: (projectId: string, data: { principalType: string; principalId: string; role: string }) =>
    api.post<ProjectMember>(`/projects/${projectId}/members`, data),

  updateMemberPermissions: (projectId: string, memberId: string, grants: Array<{ permissionKey: string }>) =>
    api.patch<ProjectMember>(`/projects/${projectId}/members/${memberId}/permissions`, { grants }),

  applyMemberRolePreset: (projectId: string, memberId: string, presetId: string) =>
    api.post<ProjectMember & { appliedPreset: string }>(
      `/projects/${projectId}/members/${memberId}/role-preset`,
      { presetId },
    ),

  removeMember: (projectId: string, memberId: string) =>
    api.delete<ProjectMember>(`/projects/${projectId}/members/${memberId}`),

  listAgentsAccess: (projectId: string) =>
    api.get<ProjectAgentAccess[]>(`/projects/${projectId}/agents-access`),

  addAgentAccess: (projectId: string, agentId: string) =>
    api.post<ProjectAgentAccess>(`/projects/${projectId}/agents-access`, { agentId }),

  removeAgentAccess: (projectId: string, agentId: string) =>
    api.delete<ProjectAgentAccess>(`/projects/${projectId}/agents-access/${agentId}`),
};
