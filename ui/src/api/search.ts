import type { CompanySearchResponse, CompanySearchScope, CompanySearchSort, IssuePriority, IssueStatus } from "@paperclipai/shared";
import { api } from "./client";

export interface CompanySearchParams {
  q: string;
  scope?: CompanySearchScope;
  limit?: number;
  offset?: number;
  status?: IssueStatus[];
  priority?: IssuePriority[];
  assigneeAgentId?: string | null;
  assigneeUserId?: string;
  projectId?: string;
  labelId?: string;
  updatedWithin?: string;
  updatedAfter?: string;
  sort?: CompanySearchSort;
}

function appendMulti(search: URLSearchParams, key: string, values: readonly string[] | undefined) {
  for (const value of values ?? []) search.append(key, value);
}

export const searchApi = {
  search: (companyId: string, params: CompanySearchParams) => {
    const search = new URLSearchParams();
    search.set("q", params.q);
    if (params.scope) search.set("scope", params.scope);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    appendMulti(search, "status", params.status);
    appendMulti(search, "priority", params.priority);
    if (params.assigneeAgentId !== undefined) search.set("assigneeAgentId", params.assigneeAgentId ?? "null");
    if (params.assigneeUserId !== undefined) search.set("assigneeUserId", params.assigneeUserId);
    if (params.projectId !== undefined) search.set("projectId", params.projectId);
    if (params.labelId !== undefined) search.set("labelId", params.labelId);
    if (params.updatedWithin !== undefined) search.set("updatedWithin", params.updatedWithin);
    if (params.updatedAfter !== undefined) search.set("updatedAfter", params.updatedAfter);
    if (params.sort !== undefined) search.set("sort", params.sort);
    const qs = search.toString();
    return api.get<CompanySearchResponse>(
      `/companies/${companyId}/search${qs ? `?${qs}` : ""}`,
    );
  },
};
