import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

export const approvalsApi = {
  list: (companyId: string, filter?: string | { status?: string; teamId?: string }) => {
    // Backwards compat: accept plain string for old `list(companyId, status)` callers.
    const f = typeof filter === "string" ? { status: filter } : filter ?? {};
    const qs = new URLSearchParams();
    if (f.status) qs.set("status", f.status);
    if (f.teamId) qs.set("teamId", f.teamId);
    const suffix = qs.toString();
    return api.get<Approval[]>(
      `/companies/${companyId}/approvals${suffix ? "?" + suffix : ""}`,
    );
  },
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
