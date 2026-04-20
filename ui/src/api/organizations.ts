import { api } from "./client";

export interface Organization {
  id: string;
  name: string;
  ownerUserId: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OrgMember {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  displayName: string | null;
  email: string | null;
  createdAt: string;
}

export const organizationsApi = {
  list: () => api.get<Organization[]>("/organizations"),

  get: (id: string) => api.get<Organization>(`/organizations/${id}`),

  create: (data: { name: string }) => api.post<Organization>("/organizations", data),

  update: (id: string, data: { name?: string; settings?: Record<string, unknown> }) =>
    api.patch<Organization>(`/organizations/${id}`, data),

  listCompanies: (organizationId: string) =>
    api.get<Array<{ id: string; name: string; status: string; organizationId: string | null }>>(
      `/organizations/${organizationId}/companies`,
    ),

  attachCompany: (organizationId: string, companyId: string) =>
    api.post<{ ok: true }>(`/organizations/${organizationId}/companies/${companyId}`, {}),

  detachCompany: (organizationId: string, companyId: string) =>
    api.delete<{ ok: true }>(`/organizations/${organizationId}/companies/${companyId}`),

  listMembers: (organizationId: string) =>
    api.get<OrgMember[]>(`/organizations/${organizationId}/members`),

  addMember: (
    organizationId: string,
    data: { userId?: string; email?: string; role?: string },
  ) => api.post<OrgMember>(`/organizations/${organizationId}/members`, data),

  removeMember: (organizationId: string, userId: string) =>
    api.delete<OrgMember>(`/organizations/${organizationId}/members/${userId}`),
};
