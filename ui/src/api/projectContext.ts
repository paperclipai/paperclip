import type {
  ContextSource,
  ContextSourceCreateRequest,
  ContextSourceSearchResult,
  ProjectContextOverview,
  ProjectContextProfile,
  ProjectContextProfileUpdateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

function basePath(companyId: string, projectId: string) {
  return `/companies/${encodeURIComponent(companyId)}/projects/${encodeURIComponent(projectId)}/context`;
}

export const projectContextApi = {
  overview: (companyId: string, projectId: string) =>
    api.get<ProjectContextOverview>(basePath(companyId, projectId)),

  updateProfile: (companyId: string, projectId: string, payload: ProjectContextProfileUpdateRequest) =>
    api.patch<ProjectContextProfile>(basePath(companyId, projectId), payload),

  createSource: (companyId: string, projectId: string, payload: ContextSourceCreateRequest) =>
    api.post<ContextSource>(`${basePath(companyId, projectId)}/sources`, payload),

  uploadSourceFile: (companyId: string, projectId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return api.postForm<ContextSource>(`${basePath(companyId, projectId)}/sources/upload`, form);
  },

  syncSource: (companyId: string, sourceId: string) =>
    api.post<ContextSource>(
      `/companies/${encodeURIComponent(companyId)}/context/sources/${encodeURIComponent(sourceId)}/sync`,
      {},
    ),

  deleteSource: (companyId: string, sourceId: string) =>
    api.delete<ContextSource>(
      `/companies/${encodeURIComponent(companyId)}/context/sources/${encodeURIComponent(sourceId)}`,
    ),

  search: (companyId: string, projectId: string, query: string, limit = 8) =>
    api.get<ContextSourceSearchResult[]>(
      `${basePath(companyId, projectId)}/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    ),
};
