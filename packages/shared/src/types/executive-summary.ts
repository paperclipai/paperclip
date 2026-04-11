import type {
  CompanyKpiTrend,
  ExecutiveSummarySendStatus,
  HeartbeatRunStatus,
  IssueStatus,
} from "../constants.js";

export interface CompanyKpi {
  id: string;
  companyId: string;
  label: string;
  value: string;
  trend: CompanyKpiTrend;
  note: string | null;
  position: number;
  updatedByUserId: string | null;
  updatedByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyKpiInput {
  label: string;
  value: string;
  trend: CompanyKpiTrend;
  note?: string | null;
}

export interface ExecutiveSummaryComputedKpis {
  monthSpendCents: number;
  monthBudgetCents: number;
  monthUtilizationPercent: number;
  tasksOpen: number;
  tasksInProgress: number;
  tasksBlocked: number;
  tasksDone: number;
  pendingApprovals: number;
  activeBudgetIncidents: number;
  pausedAgents: number;
  pausedProjects: number;
}

export interface ExecutiveSummaryIssueTransition {
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  fromStatus: IssueStatus | null;
  toStatus: IssueStatus;
  updatedAt: Date;
}

export interface ExecutiveSummaryFailedRun {
  runId: string;
  agentId: string;
  agentName: string | null;
  status: HeartbeatRunStatus;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ExecutiveSummaryTopChanges {
  issueTransitions: ExecutiveSummaryIssueTransition[];
  failedRuns: ExecutiveSummaryFailedRun[];
  pendingApprovals: number;
}

export interface ExecutiveSummaryDispatchState {
  enabled: boolean;
  lastSentAt: Date | null;
  lastStatus: ExecutiveSummarySendStatus | null;
  lastError: string | null;
  recipients: string[];
}

export interface ExecutiveSummary {
  companyId: string;
  companyName: string;
  generatedAt: Date;
  periodStart: Date;
  periodEnd: Date;
  manualKpis: CompanyKpi[];
  computedKpis: ExecutiveSummaryComputedKpis;
  topChanges: ExecutiveSummaryTopChanges;
  dispatch: ExecutiveSummaryDispatchState;
}
