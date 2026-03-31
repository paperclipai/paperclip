import type { AgentStatus } from "../constants.js";

export type CapacityStatus = "GREEN" | "YELLOW" | "RED";

export interface AgentWorkloadTask {
  issueId: string;
  identifier: string;
  title: string;
  startedAt: string | null;
}

export interface AgentWorkloadEntry {
  agentId: string;
  name: string;
  urlKey: string;
  status: AgentStatus;
  currentTasks: AgentWorkloadTask[];
  timeInCurrentTaskSec: number | null;
}

export interface AgentWorkload {
  capacityStatus: CapacityStatus;
  idleEngineers: number;
  queuedTasks: number;
  engineers: AgentWorkloadEntry[];
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
    monthInputTokens: number;
    monthOutputTokens: number;
  };
  pendingApprovals: number;
  agentWorkload: AgentWorkload;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
}
