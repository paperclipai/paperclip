import type { ActivityEvent, MentionEntry } from "@paperclipai/shared";
import { api } from "./client";

export type { MentionEntry } from "@paperclipai/shared";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
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
  mentions: (companyId: string, userId: string = "me") =>
    api.get<MentionEntry[]>(`/companies/${companyId}/mentions?userId=${userId}`),
};
