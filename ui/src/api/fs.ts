import { api } from "./client";

export interface FsBrowseEntry {
  name: string;
  path: string;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsBrowseEntry[];
}

export const fsApi = {
  browse: (dirPath?: string) => {
    const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
    return api.get<FsBrowseResult>(`/fs/browse${qs}`);
  },
};
