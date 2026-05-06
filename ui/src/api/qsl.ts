import { api } from "./client";

export interface QslIssue {
  id?: string;
  title: string;
  severity?: string;
  priority?: string;
  risk_score?: number;
  rule_id?: string;
  threat_category?: string;
  status?: string;
  [key: string]: unknown;
}

export interface QslApprovalRequest {
  rule_id: string;
  approved: boolean;
  reason: string;
  source: string;
}

export interface QslApprovalResponse {
  id: string;
  created_at: string;
  source: string;
  rule_id: string;
  approved: boolean;
  decision: "approve" | "deny";
  reason?: string;
}

export interface QslRule {
  id: string;
  confidence: number;
  previous_confidence?: number;
  approved: boolean | null;
  severity?: string;
}

export interface QslState {
  rules: QslRule[];
}

export const qslApi = {
  listIssues: async (): Promise<QslIssue[]> => {
    const data = await api.get<QslIssue[] | { issues?: QslIssue[] }>("/qsl/issues");
    return Array.isArray(data) ? data : data.issues ?? [];
  },
  getState: async (): Promise<QslState> => {
    return api.get<QslState>("/qsl/state");
  },
  approve: (data: QslApprovalRequest) =>
    api.post<QslApprovalResponse>("/qsl/approve", data),
};
