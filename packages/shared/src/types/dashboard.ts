export type DashboardBriefTone = "healthy" | "watch" | "at_risk" | "blocked";

export interface DashboardBriefMetric {
  value: string;
  label: string;
  headline: string;
  detail: string;
  tone: DashboardBriefTone;
}

export interface DashboardFocusArea {
  key: string;
  label: string;
  tone: DashboardBriefTone;
  changedIssueCount: number;
  blockedCount: number;
  failedRunCount: number;
  activeAgentCount: number;
  latestUpdate: string;
  href: string;
}

export interface DashboardAttentionItem {
  key: string;
  kind: "issue" | "run" | "approval" | "join_request" | "output";
  entityId: string;
  title: string;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
  timestamp: Date;
  href: string;
  ctaLabel: string;
}

export interface DashboardBrief {
  health: DashboardBriefTone;
  snapshot: {
    progress: DashboardBriefMetric;
    risk: DashboardBriefMetric;
    decisions: DashboardBriefMetric;
    spend: DashboardBriefMetric;
  };
  focusAreas: DashboardFocusArea[];
  needsAttention: DashboardAttentionItem[];
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
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  brief: DashboardBrief;
}
