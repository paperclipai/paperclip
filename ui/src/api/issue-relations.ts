import type { IssueRelationType } from "@paperclipai/shared";
import { api } from "./client";

export interface IssueRelationSummary {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: IssueRelationType;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  relatedIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  };
}

export const issueRelationsApi = {
  list: (issueId: string) =>
    api.get<IssueRelationSummary[]>(`/issues/${issueId}/relations`),
  create: (issueId: string, data: { relatedIssueId: string; type: IssueRelationType }) =>
    api.post<IssueRelationSummary>(`/issues/${issueId}/relations`, data),
  delete: (issueId: string, relationId: string) =>
    api.delete<{ ok: true }>(`/issues/${issueId}/relations/${relationId}`),
};
