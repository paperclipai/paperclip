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
  browse: (dirPath?: string, showHidden?: boolean) => {
    const params = new URLSearchParams();
    if (dirPath) params.set("path", dirPath);
    if (showHidden) params.set("showHidden", "true");
    const qs = params.size > 0 ? `?${params}` : "";
    return api.get<FsBrowseResult>(`/fs/browse${qs}`);
  },
};
