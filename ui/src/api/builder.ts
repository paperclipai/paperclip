import type {
  BuilderMessage,
  BuilderProposal,
  BuilderProviderSettings,
  BuilderSession,
  BuilderSessionDetail,
  BuilderToolCatalog,
  CreateBuilderSession,
  SendBuilderMessage,
  UpdateBuilderProviderSettings,
} from "@paperclipai/shared";
import { api } from "./client";

interface SendMessageResponse {
  userMessage: BuilderSessionDetail["messages"][number];
  newMessages: BuilderSessionDetail["messages"];
  usage: { inputTokens: number; outputTokens: number; costCents: number };
  truncated: boolean;
}

interface StreamDonePayload {
  usage: { inputTokens: number; outputTokens: number; costCents: number };
  truncated: boolean;
  messageCount: number;
}

interface StreamMessageHandlers {
  signal?: AbortSignal;
  onStart?: (payload: { sessionId: string }) => void;
  onUserMessage?: (message: BuilderMessage) => void;
  onMessage?: (message: BuilderMessage) => void;
  onDone?: (payload: StreamDonePayload) => void;
  onError?: (error: string) => void;
}

async function streamBuilderResponse(
  path: string,
  body: unknown,
  handlers: StreamMessageHandlers,
): Promise<void> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    const message =
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    handlers.onError?.(message);
    throw new Error(message);
  }

  if (!res.body) {
    const message = "Builder stream response had no body";
    handlers.onError?.(message);
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchEvent = (event: string, payloadText: string) => {
    if (!payloadText) return;
    const payload = JSON.parse(payloadText) as unknown;
    switch (event) {
      case "start":
        handlers.onStart?.(payload as { sessionId: string });
        return;
      case "user_message":
        handlers.onUserMessage?.(payload as BuilderMessage);
        return;
      case "message":
        handlers.onMessage?.(payload as BuilderMessage);
        return;
      case "done":
        handlers.onDone?.(payload as StreamDonePayload);
        return;
      case "error": {
        const message =
          typeof payload === "object" &&
          payload !== null &&
          "error" in payload &&
          typeof (payload as { error?: unknown }).error === "string"
            ? (payload as { error: string }).error
            : "Builder run failed";
        handlers.onError?.(message);
        throw new Error(message);
      }
      default:
        return;
    }
  };

  const flushBuffer = (final = false) => {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const blocks = normalized.split("\n\n");
    buffer = final ? "" : blocks.pop() ?? "";
    for (const block of final ? blocks.filter(Boolean) : blocks) {
      if (!block.trim()) continue;
      let event = "message";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice("event:".length).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trimStart());
        }
      }
      dispatchEvent(event, dataLines.join("\n"));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    flushBuffer(done);
    if (done) break;
  }
}

export const builderApi = {
  listSessions: (
    companyId: string,
    options?: { includeArchived?: boolean },
  ) => {
    const params = new URLSearchParams();
    if (options?.includeArchived) params.set("includeArchived", "true");
    const qs = params.toString();
    return api.get<{ sessions: BuilderSession[] }>(
      `/companies/${companyId}/builder/sessions${qs ? `?${qs}` : ""}`,
    );
  },

  createSession: (companyId: string, data: CreateBuilderSession) =>
    api.post<{ session: BuilderSession }>(`/companies/${companyId}/builder/sessions`, data),

  getSession: (companyId: string, sessionId: string) =>
    api.get<{ session: BuilderSessionDetail }>(
      `/companies/${companyId}/builder/sessions/${sessionId}`,
    ),

  sendMessage: (companyId: string, sessionId: string, data: SendBuilderMessage) =>
    api.post<SendMessageResponse>(
      `/companies/${companyId}/builder/sessions/${sessionId}/messages`,
      data,
    ),

  streamMessage: (
    companyId: string,
    sessionId: string,
    data: SendBuilderMessage,
    handlers: StreamMessageHandlers,
  ) =>
    streamBuilderResponse(
      `/companies/${companyId}/builder/sessions/${sessionId}/messages/stream`,
      data,
      handlers,
    ),

  abortSession: (companyId: string, sessionId: string) =>
    api.post<{ session: BuilderSession }>(
      `/companies/${companyId}/builder/sessions/${sessionId}/abort`,
      {},
    ),

  archiveSession: (companyId: string, sessionId: string) =>
    api.post<{ session: BuilderSession }>(
      `/companies/${companyId}/builder/sessions/${sessionId}/archive`,
      {},
    ),

  restoreSession: (companyId: string, sessionId: string) =>
    api.post<{ session: BuilderSession }>(
      `/companies/${companyId}/builder/sessions/${sessionId}/restore`,
      {},
    ),

  getTools: (companyId: string) =>
    api.get<BuilderToolCatalog>(`/companies/${companyId}/builder/tools`),

  getSettings: (companyId: string) =>
    api.get<{ settings: BuilderProviderSettings | null }>(
      `/companies/${companyId}/builder/settings`,
    ),

  updateSettings: (companyId: string, data: UpdateBuilderProviderSettings) =>
    api.put<{ settings: BuilderProviderSettings }>(
      `/companies/${companyId}/builder/settings`,
      data,
    ),

  listProposals: (
    companyId: string,
    filter?: { sessionId?: string; status?: BuilderProposal["status"] },
  ) => {
    const params = new URLSearchParams();
    if (filter?.sessionId) params.set("sessionId", filter.sessionId);
    if (filter?.status) params.set("status", filter.status);
    const qs = params.toString();
    return api.get<{ proposals: BuilderProposal[] }>(
      `/companies/${companyId}/builder/proposals${qs ? `?${qs}` : ""}`,
    );
  },

  getProposal: (companyId: string, proposalId: string) =>
    api.get<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}`,
    ),

  applyProposal: (companyId: string, proposalId: string) =>
    api.post<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}/apply`,
      {},
    ),

  rejectProposal: (companyId: string, proposalId: string) =>
    api.post<{ proposal: BuilderProposal }>(
      `/companies/${companyId}/builder/proposals/${proposalId}/reject`,
      {},
    ),
};
