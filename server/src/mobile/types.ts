export type MobileIssueStatus = "running" | "review_needed" | "blocked" | "done";

export type MobileAgentStatus = "idle" | "running" | "error" | "blocked";

export type MobileHealth = "ok" | "degraded" | "error";

export interface MobileIssueRow {
  id: string;
  title: string;
  status: MobileIssueStatus;
  priority: string | null;
  assigneeName: string | null;
  updatedAt: string;
  risk: string | null;
}

export interface MobileAgentRow {
  id: string;
  name: string;
  role: string;
  status: MobileAgentStatus;
  lastActivityAt: string | null;
  usageSummary: string | null;
}

export interface MobileSummary {
  health: MobileHealth;
  counts: {
    running: number;
    reviewNeeded: number;
    blocked: number;
    done: number;
  };
  latestReport: null;
}
