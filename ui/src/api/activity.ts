import type { ActivityEvent } from "@paperclipai/shared";
import { api } from "./client";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  agentName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (companyId: string) => api.get<ActivityEvent[]>(`/companies/${companyId}/activity`),
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
