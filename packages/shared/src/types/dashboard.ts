import type { IssueThreadInteractionContinuationPolicy } from "../constants.js";

export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface DashboardPendingBoardConfirmation {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  kind: "request_confirmation";
  title: string | null;
  summary: string | null;
  createdAt: Date | string;
  createdByAgentName: string | null;
  continuationPolicy: IssueThreadInteractionContinuationPolicy;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  pendingBoardConfirmations: DashboardPendingBoardConfirmation[];
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
}
