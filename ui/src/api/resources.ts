import type { Resource } from "@paperclipai/shared";
import { api } from "./client";

export type ResourceMutationInput = {
  key: string;
  type: "git";
  repository: string;
  sourcePath?: string | null;
  defaultRef: string;
  mountPath: string;
  credentialRef?: string | null;
  labels?: Record<string, string>;
};

export const resourcesApi = {
  list: (companyId: string, includeArchived = false) =>
    api.get<Resource[]>(`/companies/${companyId}/resources${includeArchived ? "?includeArchived=true" : ""}`),
  get: (id: string) => api.get<Resource>(`/resources/${id}`),
  create: (companyId: string, data: ResourceMutationInput) =>
    api.post<Resource>(`/companies/${companyId}/resources`, data),
  update: (id: string, data: Partial<ResourceMutationInput>) =>
    api.patch<Resource>(`/resources/${id}`, data),
  archive: (id: string) => api.delete<Resource>(`/resources/${id}`),
};
