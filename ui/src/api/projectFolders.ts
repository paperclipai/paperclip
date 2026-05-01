import type { ProjectFolder } from "@paperclipai/shared";
import { api } from "./client";

export const projectFoldersApi = {
  list: (companyId: string) =>
    api.get<ProjectFolder[]>(`/companies/${companyId}/project-folders`),

  create: (companyId: string, data: { name: string; sortOrder?: number }) =>
    api.post<ProjectFolder>(`/companies/${companyId}/project-folders`, data),

  update: (companyId: string, folderId: string, data: { name?: string; sortOrder?: number }) =>
    api.patch<ProjectFolder>(`/companies/${companyId}/project-folders/${encodeURIComponent(folderId)}`, data),

  reorder: (companyId: string, orderedIds: string[]) =>
    api.put<ProjectFolder[]>(`/companies/${companyId}/project-folders/order`, { orderedIds }),

  remove: (companyId: string, folderId: string) =>
    api.delete<ProjectFolder>(`/companies/${companyId}/project-folders/${encodeURIComponent(folderId)}`),
};
