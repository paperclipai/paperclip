export type OwnerAckDangerousActionType = "deploy" | "schema_migration" | "external_capability";

export type OwnerAckGateMode = "disabled" | "observe" | "enforce_agent" | "enforce_all";

export type OwnerAckGateActorType = "agent" | "board" | "system";

export type OwnerAckGateDecision = {
  mode: OwnerAckGateMode;
  actorType: OwnerAckGateActorType;
  action: "allow" | "block";
  wouldBlock: boolean;
  observed: boolean;
  bypassAvailable: boolean;
  reasons: string[];
};

export type OwnerAckAuditStatus =
  | "covered"
  | "missing_ack"
  | "expired_ack"
  | "incomplete_ack"
  | "pending_ack";

export interface OwnerAckDangerousActionMarker {
  actionType: OwnerAckDangerousActionType;
  source: "issue_text" | "work_product_metadata";
  sourceId: string | null;
  detail: string | null;
}

export interface OwnerAckApprovalSummary {
  id: string;
  type: string;
  status: string;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  expiresAt: string | null;
  exactAckPhrase: string | null;
  planHash: string | null;
  hasStablePlanText: boolean;
  missingFields: string[];
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface OwnerAckAuditIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  updatedAt: Date;
}

export interface OwnerAckAuditIssue {
  issue: OwnerAckAuditIssueSummary;
  dangerousActions: OwnerAckDangerousActionMarker[];
  approvals: OwnerAckApprovalSummary[];
  auditStatus: OwnerAckAuditStatus;
  reasons: string[];
  observeGate: OwnerAckGateDecision;
}

export interface OwnerAckAuditSummary {
  totalMarkedIssues: number;
  covered: number;
  missingAck: number;
  pendingAck: number;
  expiredAck: number;
  incompleteAck: number;
  byActionType: Record<OwnerAckDangerousActionType, number>;
}

export interface OwnerAckAuditReport {
  companyId: string;
  generatedAt: string;
  mode: "read_only";
  summary: OwnerAckAuditSummary;
  issues: OwnerAckAuditIssue[];
}
