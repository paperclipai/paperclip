export type CeoControlRoomCategoryKey =
  | "blocked_by_human"
  | "missing_secret"
  | "worker_offline"
  | "operational_loop"
  | "spend_cap"
  | "promotion_candidate";

export type CeoControlRoomSeverity = "ok" | "info" | "warning" | "critical";
export type CeoControlRoomSourceState = "ok" | "unavailable" | "not_configured";

export interface CeoControlRoomIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export interface CeoControlRoomApprovalRef {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface CeoControlRoomCategoryItem {
  type: string;
  summary: string;
  issue?: CeoControlRoomIssueRef;
  approval?: CeoControlRoomApprovalRef;
  metadata?: unknown;
}

export interface CeoControlRoomCategory {
  key: CeoControlRoomCategoryKey;
  label: string;
  severity: CeoControlRoomSeverity;
  count: number;
  items: CeoControlRoomCategoryItem[];
}

export interface CeoControlRoomSourceStatus {
  key: string;
  label: string;
  state: CeoControlRoomSourceState;
  checkedAt: string;
  details?: unknown;
  error?: string;
}

export interface CeoControlRoomStatus {
  companyId: string;
  generatedAt: string;
  summary: {
    openIssues: number;
    blockedIssues: number;
    pendingApprovals: number;
    monthSpendCents: number;
    monthBudgetCents: number;
    activeBudgetIncidents: number;
    unavailableSources: number;
  };
  sources: CeoControlRoomSourceStatus[];
  categories: CeoControlRoomCategory[];
  safety: {
    readOnly: boolean;
    brokerActions: boolean;
    paidComputeActions: boolean;
    note: string;
  };
}
