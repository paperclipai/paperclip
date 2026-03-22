import { api } from "./client";

export interface ChatThread {
  id: string;
  companyId: string;
  issueId: string | null;
  title: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  threadId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  role: string;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export const chatApi = {
  listThreads: (companyId: string, filters?: { issueId?: string; status?: string }) => {
    const params = new URLSearchParams();
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    const qs = params.toString();
    return api.get<ChatThread[]>(`/companies/${companyId}/chat/threads${qs ? `?${qs}` : ""}`);
  },
  getThread: (threadId: string) =>
    api.get<ChatThread>(`/chat/threads/${threadId}`),
  createThread: (companyId: string, data: { issueId?: string | null; title?: string | null }) =>
    api.post<ChatThread>(`/companies/${companyId}/chat/threads`, data),
  updateThread: (threadId: string, data: { title?: string | null; status?: string }) =>
    api.patch<ChatThread>(`/chat/threads/${threadId}`, data),
  listMessages: (threadId: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return api.get<ChatMessage[]>(`/chat/threads/${threadId}/messages${qs}`);
  },
  sendMessage: (threadId: string, data: { role: "user" | "assistant" | "system"; body: string }) =>
    api.post<ChatMessage>(`/chat/threads/${threadId}/messages`, data),
};
