export interface CompanyCronJob {
  id: string;
  companyId: string;
  agentId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  cronExpr: string;
  timezone: string;
  staggerMs: number;
  payload: Record<string, unknown>;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastRunDurationMs: number | null;
  lastRunId: string | null;
  consecutiveErrors: number;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}
