import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { api } from "./client";

interface ProjectMember {
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

interface ProjectAgentAccess {
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
  list: (companyId: string, opts?: { includeArchived?: boolean; archived?: boolean }) => {
    const params = new URLSearchParams();
    if (opts?.includeArchived) params.set("includeArchived", "true");
    if (opts?.archived) params.set("archived", "true");
    const qs = params.toString();
    return api.get<Project[]>(`/companies/${companyId}/projects${qs ? `?${qs}` : ""}`);
  },
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
  removeWorkspace: (projectId: string, workspaceId: string, companyId?: string) =>
    api.delete<ProjectWorkspace>(projectPath(projectId, companyId, `/workspaces/${encodeURIComponent(workspaceId)}`)),
  remove: (id: string, companyId?: string) => api.delete<Project>(projectPath(id, companyId)),
  archive: (id: string, companyId?: string) =>
    api.post<Project>(projectPath(id, companyId, "/archive"), {}),
  unarchive: (id: string, companyId?: string) =>
    api.post<Project>(projectPath(id, companyId, "/unarchive"), {}),

  // Project Members
  listMembers: (projectId: string) =>
    api.get<ProjectMember[]>(`/projects/${projectId}/members`),

  addMember: (projectId: string, data: { principalType: string; principalId: string; role: string }) =>
    api.post<ProjectMember>(`/projects/${projectId}/members`, data),

  updateMemberPermissions: (projectId: string, memberId: string, grants: Array<{ permissionKey: string }>) =>
    api.patch<ProjectMember>(`/projects/${projectId}/members/${memberId}/permissions`, { grants }),

  applyMemberRolePreset: (projectId: string, memberId: string, presetId: string) =>
    api.post<ProjectMember & { appliedPreset: string }>(`/projects/${projectId}/members/${memberId}/role-preset`, { presetId }),

  removeMember: (projectId: string, memberId: string) =>
    api.delete<ProjectMember>(`/projects/${projectId}/members/${memberId}`),

  // Project Agents
  listAgentsAccess: (projectId: string) =>
    api.get<ProjectAgentAccess[]>(`/projects/${projectId}/agents-access`),

  addAgentAccess: (projectId: string, agentId: string) =>
    api.post<ProjectAgentAccess>(`/projects/${projectId}/agents-access`, { agentId }),

  removeAgentAccess: (projectId: string, agentId: string) =>
    api.delete<ProjectAgentAccess>(`/projects/${projectId}/agents-access/${agentId}`),
};
