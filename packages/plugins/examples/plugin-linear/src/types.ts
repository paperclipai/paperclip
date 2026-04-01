export interface CycleSnapshot {
  teamKey: string;
  teamName: string;
  number: number;
  name: string | null;
  progress: number;
  startsAt: string;
  endsAt: string;
  daysRemaining: number;
  scopeHistory: number[];
  completedScopeHistory: number[];
}

export interface ProjectSnapshot {
  name: string;
  state: string;
  progress: number;
  lead: string | null;
  targetDate: string | null;
  url: string;
}

export interface TeamSnapshot {
  name: string;
  key: string;
  openIssues: number;
  inProgressIssues: number;
  completedThisWeek: number;
  avgResolutionHours: number;
}

export interface LinearSnapshot {
  syncedAt: string;
  workspace: string;
  teamCount: number;
  totalOpenIssues: number;
  issuesCreatedThisWeek: number;
  issuesCompletedThisWeek: number;
  avgResolutionHours: number;
  priorityDistribution: Record<string, number>;
  activeCycles: CycleSnapshot[];
  activeProjects: ProjectSnapshot[];
  teams: TeamSnapshot[];
  topAssignees: Array<{ name: string; completedThisWeek: number; inProgress: number }>;
}

export interface IssueRow {
  identifier: string;
  title: string;
  priority: number;
  priorityLabel: string;
  state: string;
  stateType: string;
  assignee: string | null;
  team: string;
  createdAt: string;
  updatedAt: string;
  dueDate: string | null;
  url: string;
}

export interface LinearSummaryResult {
  status: "ok" | "pending";
  message?: string;
  snapshot?: LinearSnapshot;
}
