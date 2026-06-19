import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileListMode,
  WorkspaceFileListResponse,
  WorkspaceFileSelector,
} from "@paperclipai/shared";
import { api } from "./client";

export interface FileResourceQuery {
  path: string;
  workspace?: WorkspaceFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
}

export interface FileResourceListQuery {
  workspace?: WorkspaceFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
  path?: string | null;
  mode?: WorkspaceFileListMode;
  q?: string | null;
  limit?: number;
  offset?: number;
}

function buildQuery(query: FileResourceQuery | FileResourceListQuery): string {
  const params = new URLSearchParams();
  if (query.projectId && query.workspaceId) {
    params.set("projectId", query.projectId);
    params.set("workspaceId", query.workspaceId);
  }
  if ("path" in query && query.path) params.set("path", query.path);
  if (query.workspace && query.workspace !== "auto") {
    params.set("workspace", query.workspace);
  }
  if ("mode" in query && query.mode && query.mode !== "all") params.set("mode", query.mode);
  if ("q" in query && query.q) params.set("q", query.q);
  if ("limit" in query && query.limit) params.set("limit", String(query.limit));
  if ("offset" in query && query.offset) params.set("offset", String(query.offset));
  return params.toString();
}

export const fileResourcesApi = {
  list(issueId: string, query: FileResourceListQuery = {}): Promise<WorkspaceFileListResponse> {
    const search = buildQuery(query);
    const suffix = search ? `?${search}` : "";
    return api.get<WorkspaceFileListResponse>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/list${suffix}`,
    );
  },

  resolve(issueId: string, query: FileResourceQuery): Promise<ResolvedWorkspaceResource> {
    return api.get<ResolvedWorkspaceResource>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/resolve?${buildQuery(query)}`,
    );
  },

  content(issueId: string, query: FileResourceQuery): Promise<WorkspaceFileContent> {
    return api.get<WorkspaceFileContent>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/content?${buildQuery(query)}`,
    );
  },
};
