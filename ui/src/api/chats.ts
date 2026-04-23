import { api } from "./client";

export interface AgentChat {
  id: string;
  companyId: string;
  agentId: string;
  initiatedByUserId: string;
  title: string | null;
  status: "active" | "archived";
  issueId: string | null;
  anchorCommentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentChatMessage {
  id: string;
  companyId: string;
  chatId: string;
  role: "user" | "agent" | "system";
  body: string;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentChatWithMessages extends AgentChat {
  messages: AgentChatMessage[];
}

export interface SendMessageResult {
  message: AgentChatMessage;
  runId: string | null;
}

function chatBasePath(agentId: string) {
  return `/agents/${encodeURIComponent(agentId)}/chats`;
}

export const chatsApi = {
  list: (agentId: string) => api.get<AgentChat[]>(chatBasePath(agentId)),

  create: (agentId: string) => api.post<AgentChat>(chatBasePath(agentId), {}),

  get: (agentId: string, chatId: string) =>
    api.get<AgentChatWithMessages>(`${chatBasePath(agentId)}/${encodeURIComponent(chatId)}`),

  update: (agentId: string, chatId: string, data: { title?: string; status?: "active" | "archived" }) =>
    api.patch<AgentChat>(`${chatBasePath(agentId)}/${encodeURIComponent(chatId)}`, data),

  getMessages: (agentId: string, chatId: string) =>
    api.get<AgentChatMessage[]>(`${chatBasePath(agentId)}/${encodeURIComponent(chatId)}/messages`),

  sendMessage: (agentId: string, chatId: string, body: string) =>
    api.post<SendMessageResult>(`${chatBasePath(agentId)}/${encodeURIComponent(chatId)}/messages`, { body }),
};

export interface QuickChatResponse {
  chat: AgentChat;
  messages: AgentChatMessage[];
}

function quickChatBasePath(issueId: string, commentId: string) {
  return `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}/quick-chat`;
}

export const quickChatsApi = {
  get: (issueId: string, commentId: string, agentId: string) =>
    api.get<QuickChatResponse>(`${quickChatBasePath(issueId, commentId)}?agentId=${encodeURIComponent(agentId)}`),

  createOrGet: (issueId: string, commentId: string, agentId: string) =>
    api.post<QuickChatResponse>(quickChatBasePath(issueId, commentId), { agentId }),

  sendMessage: (issueId: string, commentId: string, agentId: string, body: string) =>
    api.post<SendMessageResult>(`${quickChatBasePath(issueId, commentId)}/messages`, { agentId, body }),
};
