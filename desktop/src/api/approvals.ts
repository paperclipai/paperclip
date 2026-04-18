import { tauriInvoke } from "./tauri-client";

export interface Approval {
  id: string;
  company_id: string;
  type: string;
  status: "pending" | "approved" | "rejected" | "revision_requested";
  requested_by_agent_id: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    tauriInvoke<Approval[]>("list_approvals", { companyId, status }),
  create: (companyId: string, approvalType: string, requestedBy?: string) =>
    tauriInvoke<Approval>("create_approval", { companyId, approvalType, requestedBy }),
  approve: (id: string, note?: string) =>
    tauriInvoke<Approval>("approve_approval", { id, note }),
  reject: (id: string, note?: string) =>
    tauriInvoke<Approval>("reject_approval", { id, note }),
};
