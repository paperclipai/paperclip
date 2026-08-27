import type { RecentIssue } from "@paperclipai/shared";
import { api } from "./client";

export const recentIssuesApi = {
  list: (companyId: string, limit = 25) =>
    api.get<RecentIssue[]>(`/companies/${companyId}/users/me/recent-issues?limit=${limit}`),
};
