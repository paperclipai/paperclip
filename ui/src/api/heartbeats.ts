import type { HeartbeatRun, HeartbeatRunEvent, InstanceSchedulerHeartbeatAgent, WorkspaceOperation } from "@paperclipai/shared";
import { api } from "./client";

export interface ActiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  createdAt: string | Date;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  issueId?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLiveRunRecord(value: unknown): value is LiveRunForIssue {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.status)
    && isNonEmptyString(value.invocationSource)
    && isNonEmptyString(value.agentId)
    && isNonEmptyString(value.agentName)
    && isNonEmptyString(value.adapterType)
    && isNonEmptyString(value.createdAt);
}

function sanitizeLiveRuns(value: unknown): LiveRunForIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isLiveRunRecord);
}

function sanitizeActiveRun(value: unknown): ActiveRunForIssue | null {
  if (value === null) return null;
  return isLiveRunRecord(value) ? value : null;
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`);
  },
  get: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/heartbeat-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<unknown>(`/issues/${issueId}/live-runs`).then(sanitizeLiveRuns),
  activeRunForIssue: (issueId: string) =>
    api.get<unknown>(`/issues/${issueId}/active-run`).then(sanitizeActiveRun),
  liveRunsForCompany: (companyId: string, minCount?: number) =>
    api.get<unknown>(`/companies/${companyId}/live-runs${minCount ? `?minCount=${minCount}` : ""}`).then(sanitizeLiveRuns),
  listInstanceSchedulerAgents: () =>
    api.get<InstanceSchedulerHeartbeatAgent[]>("/instance/scheduler-heartbeats"),
};
