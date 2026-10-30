import type { ActivityEvent, ExecutionProjection, RunLivenessState } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export type { RunLivenessState } from "@paperclipai/shared";

export interface RunForIssue {
  runId: string;
  execution?: ExecutionProjection | null;
  runtimeMode?: "legacy" | "native";
  wakeupRequestId?: string | null;
  queuedCommentSourceWakeIds?: string[] | null;
  status: string;
  agentId: string;
  adapterType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  responsibleUserId?: string | null;
  errorCode?: string | null;
  /** Bounded model rejection or the fixed credential-sharing denial message. */
  error?: string | null;
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
  wakeCommentIds?: string[] | null;
  wakeCommentId?: string | null;
  contextCommentId?: string | null;
  contextIssueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  environment?: {
    id: string;
    name: string;
    driver: string;
  } | null;
  environmentLease?: {
    id: string;
    status: string;
    leasePolicy: string;
    provider: string | null;
    providerLeaseId: string | null;
    executionWorkspaceId: string | null;
    workspacePath: string | null;
    failureReason: string | null;
    cleanupStatus: string | null;
    acquiredAt: string | Date;
    releasedAt: string | Date | null;
  } | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (
    companyId: string,
    filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number },
    options?: RequestOptions,
  ) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`, options);
  },
  recentForIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity?view=recent`),
  inputFactsForIssue: async (issueId: string, commentIds: string[]) => {
    const batches: Promise<ActivityEvent[]>[] = [];
    for (let start = 0; start < commentIds.length; start += 100) {
      const params = new URLSearchParams({ view: "comment-inputs", commentIds: commentIds.slice(start, start + 100).join(",") });
      batches.push(api.get<ActivityEvent[]>(`/issues/${issueId}/activity?${params}`));
    }
    return (await Promise.all(batches)).flat();
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  recentRunsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs?view=recent`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
