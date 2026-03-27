export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostTrendPoint {
  date: string;
  spendCents: number;
  cumulativeCents: number;
}

export interface CostTrend {
  points: CostTrendPoint[];
  budgetCents: number;
}

export interface CostForecast {
  projectedMonthEndCents: number;
  daysUntilExhaustion: number | null;
  dailyAvgCents: number;
  pacingStatus: "on_track" | "over_pacing" | "critical";
}

export interface CostEfficiencyAgent {
  agentId: string;
  agentName: string | null;
  costPerTaskCompleted: number | null;
  costPerTaskAttempted: number | null;
  avgCostPerRun: number | null;
  tasksCompleted: number;
  tasksAttempted: number;
  totalRuns: number;
  totalCostCents: number;
}
