import type {
  HeartbeatRun,
  HeartbeatRunEvent,
  WorkspaceOperation,
  ProviderTraceFrame,
  ProviderTraceMetadata,
} from "@paperclipai/shared";
import { tenantSessionRecovery } from "@/lib/tenant-session-recovery";
import { api } from "./client";

export interface RunLivenessFields {
  livenessState: HeartbeatRun["livenessState"];
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: string | Date | null;
  nextAction: string | null;
}

export interface ActiveRunForIssue {
  id: string;
  runtimeMode?: "legacy" | "native";
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  contextCommentId?: string | null;
  contextWakeCommentId?: string | null;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  createdAt: string | Date;
  agentId: string;
  agentName: string;
  adapterType: string;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
  issueId?: string | null;
  livenessState?: RunLivenessFields["livenessState"];
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | Date | null;
  nextAction?: string | null;
  outputSilence?: HeartbeatRun["outputSilence"];
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: string | Date | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: string | Date | null;
}

export interface LiveRunForIssue {
  id: string;
  runtimeMode?: "legacy" | "native";
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  contextCommentId?: string | null;
  contextWakeCommentId?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  logBytes?: number | null;
  lastOutputBytes?: number | null;
  issueId?: string | null;
  livenessState?: RunLivenessFields["livenessState"];
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | null;
  nextAction?: string | null;
  outputSilence?: HeartbeatRun["outputSilence"];
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: string | null;
}

export interface WatchdogDecisionInput {
  runId: string;
  decision: "snooze" | "continue" | "dismissed_false_positive";
  evaluationIssueId?: string | null;
  reason?: string | null;
  snoozedUntil?: string | null;
}

export type RuntimeRequestKind =
  | "runtime"
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "user_input"
  | "elicitation";

export type RuntimeRequestResolution =
  | { action: "accept" | "accept_for_session" | "decline" | "cancel" }
  | { action: "submit"; answers: Record<string, { answers: string[] }> }
  | { action: "submit"; content: Record<string, unknown> }
  | { action: "submit"; response: import("@paperclipai/adapter-utils").PaperclipQuestionResponse };

export interface HeartbeatRunListOptions {
  summary?: boolean;
}

export interface ProviderTraceInspection {
  trace: ProviderTraceMetadata | null;
  entries: Array<Record<string, unknown>>;
}

export const heartbeatsApi = {
  list: (
    companyId: string,
    agentId?: string,
    limit?: number,
    options: HeartbeatRunListOptions = {},
  ) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit) searchParams.set("limit", String(limit));
    if (options.summary) searchParams.set("summary", "true");
    const qs = searchParams.toString();
    return api.get<HeartbeatRun[]>(
      `/companies/${companyId}/heartbeat-runs${qs ? `?${qs}` : ""}`,
    );
  },
  get: (runId: string) => api.get<HeartbeatRun>(`/heartbeat-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/heartbeat-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{
      runId: string;
      store: string;
      logRef: string;
      content: string;
      nextOffset?: number;
    }>(
      `/heartbeat-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(
      `/heartbeat-runs/${runId}/workspace-operations`,
    ),
  providerTrace: (runId: string) =>
    api.get<ProviderTraceInspection>(`/heartbeat-runs/${runId}/provider-trace`),
  providerTraceMetadata: (companyId: string, runIds: string[]) => {
    const params = new URLSearchParams({ runIds: runIds.slice(0, 100).join(",") });
    return api.get<ProviderTraceMetadata[]>(
      `/companies/${companyId}/provider-traces?${params.toString()}`,
    );
  },
  revealProviderTraceFrame: (runId: string, frameId: number) =>
    api.post<ProviderTraceFrame>(
      `/heartbeat-runs/${runId}/provider-trace/frames/${frameId}/reveal`,
      {},
    ),
  deleteProviderTrace: (runId: string) =>
    api.delete<{ ok: true }>(`/heartbeat-runs/${runId}/provider-trace`),
  downloadProviderTrace: async (runId: string): Promise<Blob> => {
    const response = await fetch(
      `/api/heartbeat-runs/${runId}/provider-trace/download`,
      {
        credentials: "include",
        headers: { Accept: "application/x-ndjson" },
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      const recovery = tenantSessionRecovery.recoverIfNeeded(response.status, body);
      if (recovery) return recovery;
      throw new Error(
        body?.error ?? `Trace download failed: ${response.status}`,
      );
    }
    return response.blob();
  },
  workspaceOperationLog: (
    operationId: string,
    offset = 0,
    limitBytes = 256000,
  ) =>
    api.get<{
      operationId: string;
      store: string;
      logRef: string;
      content: string;
      nextOffset?: number;
    }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
    ),
  cancel: (runId: string) =>
    api.post<void>(`/heartbeat-runs/${runId}/cancel`, {}),
  resolveRuntimeRequest: (input: {
    runId: string;
    requestId: string;
    turnId: string;
    requestKind: RuntimeRequestKind;
    resolution: RuntimeRequestResolution;
  }) =>
    api.post<{ accepted: true; commandId: string }>(
      `/heartbeat-runs/${input.runId}/runtime-requests/${encodeURIComponent(input.requestId)}/resolve`,
      {
        turnId: input.turnId,
        requestKind: input.requestKind,
        resolution: input.resolution,
      },
    ),
  recordWatchdogDecision: (input: WatchdogDecisionInput) =>
    api.post(`/heartbeat-runs/${input.runId}/watchdog-decisions`, {
      decision: input.decision,
      evaluationIssueId: input.evaluationIssueId ?? null,
      reason: input.reason ?? null,
      snoozedUntil: input.snoozedUntil ?? null,
    }),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (
    companyId: string,
    options?: number | { minCount?: number; limit?: number },
  ) => {
    const searchParams = new URLSearchParams();
    if (typeof options === "number") {
      searchParams.set("minCount", String(options));
    } else if (options) {
      if (options.minCount)
        searchParams.set("minCount", String(options.minCount));
      if (options.limit) searchParams.set("limit", String(options.limit));
    }
    const qs = searchParams.toString();
    return api.get<LiveRunForIssue[]>(
      `/companies/${companyId}/live-runs${qs ? `?${qs}` : ""}`,
    );
  },
};
