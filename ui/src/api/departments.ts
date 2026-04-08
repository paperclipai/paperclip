import { api } from "./client";

export interface Department {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DepartmentTreeNode extends Department {
  children: DepartmentTreeNode[];
  memberCount: number;
}

export interface DepartmentMembership {
  id: string;
  companyId: string;
  departmentId: string;
  principalType: string;
  principalId: string;
  role: string;
  createdAt: string;
}

export interface Team {
  id: string;
  companyId: string;
  departmentId: string | null;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMembership {
  id: string;
  companyId: string;
  teamId: string;
  principalType: string;
  principalId: string;
  role: string;
  createdAt: string;
}

export const departmentsApi = {
  list: (companyId: string) => api.get<Department[]>(`/companies/${companyId}/departments`),
  tree: (companyId: string) => api.get<DepartmentTreeNode[]>(`/companies/${companyId}/departments/tree`),
  getById: (id: string) => api.get<Department>(`/departments/${id}`),
  create: (companyId: string, data: { name: string; description?: string; parentId?: string | null }) =>
    api.post<Department>(`/companies/${companyId}/departments`, data),
  update: (id: string, data: Partial<{ name: string; description: string | null; parentId: string | null; sortOrder: number }>) =>
    api.patch<Department>(`/departments/${id}`, data),
  archive: (id: string) => api.post<Department>(`/departments/${id}/archive`, {}),
  listMembers: (id: string) => api.get<DepartmentMembership[]>(`/departments/${id}/members`),
  addMember: (id: string, data: { principalType: string; principalId: string; role?: string }) =>
    api.post<DepartmentMembership>(`/departments/${id}/members`, data),
  removeMember: (id: string, principalType: string, principalId: string) =>
    api.delete(`/departments/${id}/members/${principalType}/${principalId}`),
};

export const teamsApi = {
  list: (companyId: string) => api.get<Team[]>(`/companies/${companyId}/teams`),
  getById: (id: string) => api.get<Team>(`/teams/${id}`),
  create: (companyId: string, data: { name: string; description?: string; departmentId?: string | null }) =>
    api.post<Team>(`/companies/${companyId}/teams`, data),
  update: (id: string, data: Partial<{ name: string; description: string | null; departmentId: string | null }>) =>
    api.patch<Team>(`/teams/${id}`, data),
  archive: (id: string) => api.post<Team>(`/teams/${id}/archive`, {}),
  listMembers: (id: string) => api.get<TeamMembership[]>(`/teams/${id}/members`),
  addMember: (id: string, data: { principalType: string; principalId: string; role?: string }) =>
    api.post<TeamMembership>(`/teams/${id}/members`, data),
  removeMember: (id: string, principalType: string, principalId: string) =>
    api.delete(`/teams/${id}/members/${principalType}/${principalId}`),
};
