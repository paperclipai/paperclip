import { api } from "./client";

export interface HeartbeatRun {
  id: string;
  agentId: string;
  companyId: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
}

export interface LiveRun extends HeartbeatRun {
  issueId?: string | null;
  issueIdentifier?: string | null;
  adapterType?: string | null;
}

export interface RunEvent {
  seq: number;
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

export interface WorkspaceOperation {
  id: string;
  runId: string;
  companyId: string;
  type: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
}

export interface WatchdogDecisionInput {
  action: string;
  reason: string;
  snoozedUntil?: string | null;
}

export function heartbeatRunLogStreamPath(runId: string, offset = 0, limitBytes = 256000): string {
  return `/api/heartbeat-runs/${encodeURIComponent(runId)}/log/stream?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`;
}

export const heartbeatsApi = {
  list: (companyId: string, agentId?: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit != null) searchParams.set("limit", String(limit));
    return api.get<HeartbeatRun[]>(`/companies/${companyId}/heartbeat-runs?${searchParams.toString()}`);
  },
  run: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, minSeq?: number, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (minSeq != null) searchParams.set("minSeq", String(minSeq));
    if (limit != null) searchParams.set("limit", String(limit));
    return api.get<RunEvent[]>(`/heartbeat-runs/${runId}/events?${searchParams.toString()}`);
  },
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; nextOffset?: number }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  logStreamPath: (runId: string, offset = 0, limitBytes = 256000) =>
    heartbeatRunLogStreamPath(runId, offset, limitBytes),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/heartbeat-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ content: string; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) => api.post(`/heartbeat-runs/${runId}/cancel`),
  watchdogDecision: (runId: string, input: WatchdogDecisionInput) =>
    api.post(`/heartbeat-runs/${runId}/watchdog-decisions`, input),
  liveRunsForCompany: (companyId: string, minCount?: number, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (minCount != null) searchParams.set("minCount", String(minCount));
    if (limit != null) searchParams.set("limit", String(limit));
    return api.get<LiveRun[]>(`/companies/${companyId}/live-runs?${searchParams.toString()}`);
  },
  liveRunsForIssue: (issueId: string, limit?: number) => {
    const searchParams = new URLSearchParams();
    if (limit != null) searchParams.set("limit", String(limit));
    return api.get<LiveRun[]>(`/issues/${issueId}/live-runs?${searchParams.toString()}`);
  },
  activeRunForIssue: (issueId: string) =>
    api.get<LiveRun | null>(`/issues/${issueId}/active-run`),
};
