import type {
  ChatMessage,
  ChatSession,
  CreateChatMessageResponse,
  CreateChatSessionResponse,
} from "@paperclipai/shared";
import { api } from "./client";

function sessionsBasePath(agentId: string) {
  return `/agents/${encodeURIComponent(agentId)}/chat/sessions`;
}

function messagesBasePath(agentId: string, sessionId: string) {
  return `${sessionsBasePath(agentId)}/${encodeURIComponent(sessionId)}/messages`;
}

export interface ChatLogEvent {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

export const chatApi = {
  listSessions: (agentId: string) => api.get<ChatSession[]>(sessionsBasePath(agentId)),
  createSession: (agentId: string, body?: { title?: string }) =>
    api.post<CreateChatSessionResponse>(sessionsBasePath(agentId), body ?? {}),
  updateSession: (agentId: string, sessionId: string, body: { title?: string | null; archived?: boolean }) =>
    api.patch<{ session: ChatSession }>(
      `${sessionsBasePath(agentId)}/${encodeURIComponent(sessionId)}`,
      body,
    ),
  listMessages: (agentId: string, sessionId: string) =>
    api.get<ChatMessage[]>(messagesBasePath(agentId, sessionId)),
  sendMessage: (agentId: string, sessionId: string, body: { content: string }) =>
    api.post<CreateChatMessageResponse>(messagesBasePath(agentId, sessionId), body),
  streamUrl: (agentId: string, sessionId: string, messageId: string) =>
    `/api${messagesBasePath(agentId, sessionId)}/${encodeURIComponent(messageId)}/stream`,
};
