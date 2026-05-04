import type {
  BudgetIncidentResolutionAction,
  BudgetIncidentStatus,
  BudgetMetric,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
  PauseReason,
} from "../constants.js";

export interface BudgetPolicy {
  id: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetPolicySummary {
  policyId: string;
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  amount: number;
  observedAmount: number;
  remainingAmount: number;
  utilizationPercent: number;
  warnPercent: number;
  hardStopEnabled: boolean;
  notifyEnabled: boolean;
  isActive: boolean;
  status: "ok" | "warning" | "hard_stop";
  paused: boolean;
  pauseReason: PauseReason | null;
  windowStart: Date;
  windowEnd: Date;
  /**
   * Count of runs in this window that contributed to the policy scope but
   * could not be priced (adapter returned no costUsd and the pricing service
   * had no entry for the model). The UI surfaces this so observedAmount is
   * not silently undercounted. Defaults to 0.
   */
  unpricedRunCount: number;
}

export interface BudgetIncident {
  id: string;
  companyId: string;
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  metric: BudgetMetric;
  windowKind: BudgetWindowKind;
  windowStart: Date;
  windowEnd: Date;
  thresholdType: BudgetThresholdType;
  amountLimit: number;
  amountObserved: number;
  status: BudgetIncidentStatus;
  approvalId: string | null;
  approvalStatus: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetOverview {
  companyId: string;
  policies: BudgetPolicySummary[];
  activeIncidents: BudgetIncident[];
  pausedAgentCount: number;
  pausedProjectCount: number;
  pendingApprovalCount: number;
  /**
   * Aggregate count of runs across all policies that could not be priced.
   * Surfaces a company-wide "+N unpriced" badge in the budget overview.
   * Defaults to 0.
   */
  unpricedRunCount: number;
}

export interface BudgetPolicyUpsertInput {
  scopeType: BudgetScopeType;
  scopeId: string;
  metric?: BudgetMetric;
  windowKind?: BudgetWindowKind;
  amount: number;
  warnPercent?: number;
  hardStopEnabled?: boolean;
  notifyEnabled?: boolean;
  isActive?: boolean;
}

export interface BudgetIncidentResolutionInput {
  action: BudgetIncidentResolutionAction;
  amount?: number;
  decisionNote?: string | null;
}
