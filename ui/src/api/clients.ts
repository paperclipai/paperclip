import type { Client, ClientProject } from "@paperclipai/shared";
import { api } from "./client";

interface PaginatedResponse<T> {
  data: T[];
  total: number;
}

export const clientsApi = {
  list: (companyId: string, params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.offset) searchParams.set("offset", String(params.offset));
    const qs = searchParams.toString();
    return api.get<PaginatedResponse<Client>>(
      `/companies/${companyId}/clients${qs ? `?${qs}` : ""}`,
    );
  },
  get: (id: string) => api.get<Client>(`/clients/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Client>(`/companies/${companyId}/clients`, data),
  update: (id: string, data: Record<string, unknown>) =>
    api.patch<Client>(`/clients/${id}`, data),
  remove: (id: string) => api.delete<Client>(`/clients/${id}`),
  listProjects: (clientId: string) =>
    api.get<ClientProject[]>(`/clients/${clientId}/projects`),
  createProject: (clientId: string, data: Record<string, unknown>) =>
    api.post<ClientProject>(`/clients/${clientId}/projects`, data),
  updateProject: (id: string, data: Record<string, unknown>) =>
    api.patch<ClientProject>(`/client-projects/${id}`, data),
  removeProject: (id: string) => api.delete<ClientProject>(`/client-projects/${id}`),
};
