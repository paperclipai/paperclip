import type {
  CreateFolderRequest,
  EnsureMySkillFolderRequest,
  Folder,
  FolderKind,
  FolderListResult,
  MoveFolderItemRequest,
  MoveFolderRequest,
  UpdateFolderRequest,
} from "@paperclipai/shared";
import { api } from "./client";

export const foldersApi = {
  list: (companyId: string, kind: FolderKind) =>
    api.get<FolderListResult>(`/companies/${encodeURIComponent(companyId)}/folders?kind=${kind}`),
  create: (companyId: string, payload: CreateFolderRequest) =>
    api.post<Folder>(`/companies/${encodeURIComponent(companyId)}/folders`, payload),
  ensureMy: (companyId: string, payload: EnsureMySkillFolderRequest = {}) =>
    api.post<Folder>(`/companies/${encodeURIComponent(companyId)}/folders/ensure-my`, payload),
  update: (companyId: string, folderId: string, payload: UpdateFolderRequest) =>
    api.patch<Folder>(
      `/companies/${encodeURIComponent(companyId)}/folders/${encodeURIComponent(folderId)}`,
      payload,
    ),
  moveFolder: (companyId: string, folderId: string, payload: MoveFolderRequest) =>
    api.post<Folder>(
      `/companies/${encodeURIComponent(companyId)}/folders/${encodeURIComponent(folderId)}/move`,
      payload,
    ),
  moveItem: (companyId: string, payload: MoveFolderItemRequest) =>
    api.post<MoveFolderItemRequest>(
      `/companies/${encodeURIComponent(companyId)}/folders/items/move`,
      payload,
    ),
  delete: (companyId: string, folderId: string) =>
    api.delete<{ deleted: Folder }>(
      `/companies/${encodeURIComponent(companyId)}/folders/${encodeURIComponent(folderId)}`,
    ),
};
