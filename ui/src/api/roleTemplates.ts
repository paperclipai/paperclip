import { api } from "./client";

export interface RoleTemplate {
  id: string;
  companyId: string;
  key: string;
  title: string;
  role: string;
  department: string | null;
  employmentType: string;
  description: string | null;
  defaultSkills: string[];
  defaultInstructions: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const roleTemplatesApi = {
  list: (companyId: string) =>
    api.get<RoleTemplate[]>(`/companies/${companyId}/role-templates`),

  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<RoleTemplate>(`/companies/${companyId}/role-templates`, data),

  update: (companyId: string, id: string, data: Record<string, unknown>) =>
    api.patch<RoleTemplate>(`/companies/${companyId}/role-templates/${id}`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/role-templates/${id}`),
};
