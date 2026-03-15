export type ChatMessageRole = "user" | "assistant";

export interface ChatSession {
  id: string;
  companyId: string;
  agentId: string;
  taskKey: string;
  title: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  archivedAt: Date | null;
  lastMessageAt: Date | null;
  lastRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  agentId: string;
  chatSessionId: string | null;
  role: ChatMessageRole;
  content: string;
  runId: string | null;
  createdAt: Date;
}

export interface CreateChatMessageResponse {
  message: ChatMessage;
  runId: string | null;
}

export interface CreateChatSessionResponse {
  session: ChatSession;
}
