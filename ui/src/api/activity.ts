import type { ActivityEvent, RunLivenessState } from "@paperclipai/shared";
import { api } from "./client";

export type { RunLivenessState } from "@paperclipai/shared";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  adapterType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  logBytes?: number | null;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | null;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  livenessState?: RunLivenessState | null;
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | null;
  nextAction?: string | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (companyId: string, filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
