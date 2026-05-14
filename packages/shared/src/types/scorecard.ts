export type ScorecardPulse = "green" | "amber" | "red" | "grey";

export interface ScorecardCounters {
  issues: {
    todo: number;
    inProgress: number;
    inReview: number;
    blocked: number;
    done7d: number;
  };
  agents: {
    active: number;
    idle: number;
    paused: number;
  };
  runs24h: {
    succeeded: number;
    failed: number;
    other: number;
  };
}

export interface ScorecardAttentionItem {
  issueId: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  updatedAt: string;
  reason: "blocked" | "stalled" | "in_review_waiting";
}

export interface ScorecardActivityItem {
  kind: "comment" | "status_change" | "run_started" | "run_finished";
  label: string;
  issueId: string | null;
  issueIdentifier: string | null;
  agentId: string | null;
  agentName: string | null;
  occurredAt: string;
}

export interface CompanyScorecard {
  companyId: string;
  pulse: ScorecardPulse;
  counters: ScorecardCounters;
  attention: ScorecardAttentionItem[];
  activity: ScorecardActivityItem[];
  computedAt: string;
}
