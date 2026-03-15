export type TaskCronIssueMode = "create_new" | "reuse_existing" | "reopen_existing";

export interface TaskCronSchedule {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  name: string;
  expression: string;
  timezone: string;
  enabled: boolean;
  issueMode: TaskCronIssueMode;
  issueTemplate: Record<string, unknown>;
  payload: Record<string, unknown>;
  lastTriggeredAt: Date | null;
  nextTriggerAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
