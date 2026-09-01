import type {
  ResolvedWorktreeResource,
  WorktreeFileAvailabilityResponse,
  WorktreeFileContent,
  WorktreeFileListMode,
  WorktreeFileListResponse,
  WorktreeFileSelector,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export interface FileResourceQuery {
  path: string;
  workspace?: WorktreeFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
}

export interface FileResourceListQuery {
  workspace?: WorktreeFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
  path?: string | null;
  mode?: WorktreeFileListMode;
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

export function buildFileResourceDownloadUrl(issueId: string, query: FileResourceQuery): string {
  const params = new URLSearchParams(buildQuery(query));
  params.set("download", "1");
  return `/api/issues/${encodeURIComponent(issueId)}/file-resources/content?${params.toString()}`;
}

export const fileResourcesApi = {
  list(
    issueId: string,
    query: FileResourceListQuery = {},
    options?: RequestOptions,
  ): Promise<WorktreeFileListResponse> {
    const search = buildQuery(query);
    const suffix = search ? `?${search}` : "";
    return api.get<WorktreeFileListResponse>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/list${suffix}`,
      options,
    );
  },

  /**
   * Batch preflight for auto-detected workspace file references. Callers must
   * deduplicate and chunk to the server's 100-query cap before calling.
   */
  availability(issueId: string, queries: FileResourceQuery[]): Promise<WorktreeFileAvailabilityResponse> {
    return api.post<WorktreeFileAvailabilityResponse>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/availability`,
      {
        queries: queries.map((query) => ({
          path: query.path,
          ...(query.workspace && query.workspace !== "auto" ? { workspace: query.workspace } : {}),
          ...(query.projectId && query.workspaceId
            ? { projectId: query.projectId, workspaceId: query.workspaceId }
            : {}),
        })),
      },
    );
  },

  resolve(issueId: string, query: FileResourceQuery): Promise<ResolvedWorktreeResource> {
    return api.get<ResolvedWorktreeResource>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/resolve?${buildQuery(query)}`,
    );
  },

  content(issueId: string, query: FileResourceQuery): Promise<WorktreeFileContent> {
    return api.get<WorktreeFileContent>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/content?${buildQuery(query)}`,
    );
  },

  downloadUrl: buildFileResourceDownloadUrl,
};
