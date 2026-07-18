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

export interface QslFinding {
  id: string;
  companyId: string;
  fingerprint: string;
  ruleId: string | null;
  title: string;
  severity: string | null;
  threatCategory: string | null;
  reviewState: string;
  reviewDecision: string | null;
  reviewerId: string | null;
  reviewedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  latestRiskScore: number | null;
  latestPayload: Record<string, unknown> | null;
  reviewHistory: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface QslReviewRequest {
  decision: "approved" | "denied";
  notes?: string;
}

export interface QslStateChangeRequest {
  state: string;
  notes?: string;
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

  // -- Persistent findings API ------------------------------------------
  listFindings: async (companyId: string, reviewState?: string): Promise<QslFinding[]> => {
    const params = reviewState ? `?reviewState=${reviewState}` : "";
    return api.get<QslFinding[]>(`/qsl/companies/${companyId}/findings${params}`);
  },
  reviewFinding: (companyId: string, findingId: string, data: QslReviewRequest) =>
    api.post<QslFinding>(`/qsl/companies/${companyId}/findings/${findingId}/review`, data),
  setFindingState: (companyId: string, findingId: string, data: QslStateChangeRequest) =>
    api.post<QslFinding>(`/qsl/companies/${companyId}/findings/${findingId}/state`, data),
};
