import type {
  AttachIssueKnowledgeItem,
  CreateKnowledgeItem,
  IssueKnowledgeAttachment,
  KnowledgeItem,
  UpdateKnowledgeItem,
} from "@paperclipai/shared";
import { api } from "./client";

export const knowledgeApi = {
  list: (companyId: string) => api.get<KnowledgeItem[]>(`/companies/${companyId}/knowledge-items`),
  get: (knowledgeItemId: string) => api.get<KnowledgeItem>(`/knowledge-items/${knowledgeItemId}`),
  create: (companyId: string, data: CreateKnowledgeItem) =>
    api.post<KnowledgeItem>(`/companies/${companyId}/knowledge-items`, data),
  update: (knowledgeItemId: string, data: UpdateKnowledgeItem) =>
    api.patch<KnowledgeItem>(`/knowledge-items/${knowledgeItemId}`, data),
  remove: (knowledgeItemId: string) => api.delete<{ ok: true }>(`/knowledge-items/${knowledgeItemId}`),
  listForIssue: (issueId: string) => api.get<IssueKnowledgeAttachment[]>(`/issues/${issueId}/knowledge-items`),
  attachToIssue: (issueId: string, data: AttachIssueKnowledgeItem) =>
    api.post<IssueKnowledgeAttachment>(`/issues/${issueId}/knowledge-items`, data),
  detachFromIssue: (issueId: string, knowledgeItemId: string) =>
    api.delete<{ ok: true }>(`/issues/${issueId}/knowledge-items/${knowledgeItemId}`),
};
