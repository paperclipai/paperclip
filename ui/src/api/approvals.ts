import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
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
  pause: (id: string) => api.post<Approval>(`/approvals/${id}/pause`, {}),
  schedule: (id: string, scheduledAt: string) =>
    api.post<Approval>(`/approvals/${id}/schedule`, { scheduledAt }),
  recall: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/recall`, { decisionNote }),
  updateContent: (id: string, payload: Record<string, unknown>) =>
    api.patch<Approval>(`/approvals/${id}/content`, { payload }),
  setScheduleOverride: (
    id: string,
    payload: {
      targetPublishAt?: string | null;
      targetPublishWindowStart?: string | null;
      targetPublishWindowEnd?: string | null;
      targetPublishTimezone?: string | null;
    },
  ) => api.patch<Approval>(`/approvals/${id}/schedule-override`, { payload }),
  deleteById: (id: string) => api.delete<void>(`/approvals/${id}`),
};
