import type { HeartbeatRetryState, HeartbeatRunStatus } from "../constants.js";

export interface FailedRunSummary {
  id: string;
  agentId: string;
  status: Extract<HeartbeatRunStatus, "failed" | "timed_out">;
  createdAt: Date;
  retryState: HeartbeatRetryState;
  error: string | null;
  issueId: string | null;
}

export interface InboxSummary {
  inbox: number;
  approvals: number;
  failedRuns: number;
  joinRequests: number;
  mineIssues: number;
  alerts: number;
  failedRunSummaries: FailedRunSummary[];
}

export interface CompanyRailState {
  companyId: string;
  inboxCount: number;
  hasLiveRuns: boolean;
}

export interface RunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export interface RunActivitySummary {
  days: RunActivityDay[];
}
