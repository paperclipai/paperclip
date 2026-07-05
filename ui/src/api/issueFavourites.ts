import type { IssueFavourite } from "@paperclipai/shared";
import { api } from "./client";

export const issueFavouritesApi = {
  list: (companyId: string) =>
    api.get<IssueFavourite[]>(`/companies/${companyId}/issue-favourites`),
  add: (companyId: string, issueId: string) =>
    api.post<IssueFavourite>(`/companies/${companyId}/issue-favourites`, { issueId }),
  remove: (companyId: string, issueId: string) =>
    api.delete<void>(`/companies/${companyId}/issue-favourites/${issueId}`),
};
