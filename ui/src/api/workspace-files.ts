import { api } from "./client";

export interface WorkspaceFile {
  content: string;
  path: string;
  size: number;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export const workspaceFilesApi = {
  read: (companyId: string, workspaceId: string, filePath: string) =>
    api.get<WorkspaceFile>(
      `/companies/${companyId}/workspace-files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
    ),

  write: (
    companyId: string,
    workspaceId: string,
    filePath: string,
    content: string,
  ) =>
    api.put<{ ok: true }>(
      `/companies/${companyId}/workspace-files?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(filePath)}`,
      { content },
    ),

  list: (companyId: string, workspaceId: string, dirPath = ".", showHidden = false) =>
    api.get<{ files: WorkspaceFileEntry[] }>(
      `/companies/${companyId}/workspace-files/list?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(dirPath)}&showHidden=${showHidden}`,
    ),
};
