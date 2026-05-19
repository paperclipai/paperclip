import type { CompanySearchResponse, CompanySearchScope } from "@paperclipai/shared";
import { api } from "./client";

export interface CompanySearchParams {
  q: string;
  scope?: CompanySearchScope;
  limit?: number;
  offset?: number;
}

export const searchApi = {
  search: (companyId: string, params: CompanySearchParams) => {
    const search = new URLSearchParams();
    search.set("q", params.q);
    if (params.scope) search.set("scope", params.scope);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    if (params.offset !== undefined) search.set("offset", String(params.offset));
    const qs = search.toString();
    return api.get<CompanySearchResponse>(
      `/companies/${companyId}/search${qs ? `?${qs}` : ""}`,
    );
  },
};
