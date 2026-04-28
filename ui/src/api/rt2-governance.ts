import { api } from "./client";
import type {
  Rt2Approval,
  Rt2ApprovalWithComments,
  Rt2ApprovalComment,
  Rt2GovernanceStatus,
  Rt2ActivityLogEntry,
  CreateApprovalRequest,
  ApprovalQueueFilter,
  ActorType,
} from "@paperclipai/shared";

export type { Rt2Approval, Rt2ApprovalWithComments };

function buildQueryString(params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  }
  const result = searchParams.toString();
  return result ? `?${result}` : "";
}

export const rt2GovernanceApi = {
  /**
   * Get governance status overview
   */
  getStatus: (companyId: string): Promise<Rt2GovernanceStatus> =>
    api.get<Rt2GovernanceStatus>(`/companies/${encodeURIComponent(companyId)}/rt2/governance/status`),

  /**
   * Get approval queue with optional filters
   */
  getApprovalQueue: (companyId: string, filter?: ApprovalQueueFilter): Promise<Rt2Approval[]> => {
    const qs = filter ? buildQueryString(filter as Record<string, unknown>) : "";
    return api.get<Rt2Approval[]>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals${qs}`,
    );
  },

  /**
   * Get single approval with comments
   */
  getApproval: (companyId: string, approvalId: string): Promise<Rt2ApprovalWithComments> =>
    api.get<Rt2ApprovalWithComments>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals/${encodeURIComponent(approvalId)}`,
    ),

  /**
   * Create a new approval request
   */
  createApproval: (companyId: string, data: CreateApprovalRequest): Promise<Rt2Approval> =>
    api.post<Rt2Approval>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals`,
      data,
    ),

  /**
   * Approve an approval request
   */
  approveApproval: (
    companyId: string,
    approvalId: string,
    decisionNote?: string,
  ): Promise<Rt2Approval> =>
    api.post<Rt2Approval>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals/${encodeURIComponent(approvalId)}/approve`,
      { decisionNote },
    ),

  /**
   * Reject an approval request
   */
  rejectApproval: (
    companyId: string,
    approvalId: string,
    decisionNote?: string,
  ): Promise<Rt2Approval> =>
    api.post<Rt2Approval>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals/${encodeURIComponent(approvalId)}/reject`,
      { decisionNote },
    ),

  /**
   * Add a comment to an approval
   */
  addComment: (
    companyId: string,
    approvalId: string,
    body: string,
    authorAgentId?: string,
    authorUserId?: string,
  ): Promise<Rt2ApprovalComment> =>
    api.post<Rt2ApprovalComment>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/approvals/${encodeURIComponent(approvalId)}/comments`,
      { body, authorAgentId, authorUserId },
    ),

  /**
   * Get activity log with filters
   */
  getActivityLog: (
    companyId: string,
    filters?: {
      entityType?: string;
      action?: string;
      actorType?: ActorType;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    },
  ): Promise<Rt2ActivityLogEntry[]> => {
    const qs = filters ? buildQueryString(filters as Record<string, unknown>) : "";
    return api.get<Rt2ActivityLogEntry[]>(
      `/companies/${encodeURIComponent(companyId)}/rt2/governance/activity-log${qs}`,
    );
  },
};
