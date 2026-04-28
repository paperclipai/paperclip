import { api } from "./client";

export interface WorkspaceScanResult {
  cwd: string;
  projectName: string | null;
  languages: string[];
  configFiles: string[];
  gitRemoteUrl: string | null;
  gitDefaultBranch: string | null;
  readmeExcerpt: string | null;
  topLevelEntries: string[];
}

export interface WorkspaceBrowseResult {
  path: string;
  parent: string | null;
  entries: string[];
  isProject: boolean;
}

export const workspaceApi = {
  scan: (cwd: string) =>
    api.post<WorkspaceScanResult>("/workspace/scan", { cwd }),
  browse: (path?: string) =>
    api.post<WorkspaceBrowseResult>("/workspace/browse", { path }),
};
