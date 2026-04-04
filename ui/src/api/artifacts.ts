import type {
  Artifact,
  ArtifactFolder,
  ArtifactFolderTreeNode,
} from "@paperclipai/shared";
import { api } from "./client";

export interface ListArtifactsParams {
  folderId?: string;
  issueId?: string;
  agentId?: string;
  mimeType?: string;
  search?: string;
  sort?: "name" | "createdAt" | "size";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

function buildQuery(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

export const artifactsApi = {
  // Folders
  tree: (companyId: string) =>
    api.get<ArtifactFolderTreeNode[]>(`/companies/${companyId}/artifacts/tree`),

  createFolder: (companyId: string, data: { parentId?: string; name: string } | { path: string }) =>
    api.post<ArtifactFolder>(`/companies/${companyId}/artifacts/folders`, data),

  updateFolder: (id: string, data: { name?: string; parentId?: string | null }) =>
    api.patch<ArtifactFolder>(`/artifacts/folders/${id}`, data),

  removeFolder: (id: string, recursive = false) =>
    api.delete<void>(`/artifacts/folders/${id}${recursive ? "?recursive=true" : ""}`),

  // Artifacts
  list: (companyId: string, params?: ListArtifactsParams) =>
    api.get<Artifact[]>(`/companies/${companyId}/artifacts${buildQuery({ ...params })}`),

  get: (id: string) => api.get<Artifact>(`/artifacts/${id}`),

  upload: async (
    companyId: string,
    file: File,
    opts?: { folderId?: string; path?: string; issueId?: string; title?: string; description?: string },
  ) => {
    const buffer = await file.arrayBuffer();
    const safeFile = new File([buffer], file.name, { type: file.type });
    const form = new FormData();
    form.append("file", safeFile);
    if (opts?.folderId) form.append("folderId", opts.folderId);
    if (opts?.path) form.append("path", opts.path);
    if (opts?.issueId) form.append("issueId", opts.issueId);
    if (opts?.title) form.append("title", opts.title);
    if (opts?.description) form.append("description", opts.description);
    return api.postForm<Artifact>(`/companies/${companyId}/artifacts`, form);
  },

  update: (id: string, data: { title?: string; description?: string | null; folderId?: string }) =>
    api.patch<Artifact>(`/artifacts/${id}`, data),

  remove: (id: string) => api.delete<void>(`/artifacts/${id}`),

  getContentUrl: (id: string) => `/api/artifacts/${id}/content`,

  getLocalPath: (id: string) => api.get<{ path: string }>(`/artifacts/${id}/local-path`),
};
