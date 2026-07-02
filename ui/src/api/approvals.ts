import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

export type ApprovalDecisionRequest = {
  decisionNote?: string | null;
  decisionOptionId?: string | null;
  decisionOptionLabel?: string | null;
};

function approvalDecisionBody(input?: string | ApprovalDecisionRequest | null): ApprovalDecisionRequest {
  if (typeof input === "string") return { decisionNote: input };
  return input ?? {};
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decision?: string | ApprovalDecisionRequest | null) =>
    api.post<Approval>(`/approvals/${id}/approve`, approvalDecisionBody(decision)),
  reject: (id: string, decision?: string | ApprovalDecisionRequest | null) =>
    api.post<Approval>(`/approvals/${id}/reject`, approvalDecisionBody(decision)),
  requestRevision: (id: string, decision?: string | ApprovalDecisionRequest | null) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, approvalDecisionBody(decision)),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
