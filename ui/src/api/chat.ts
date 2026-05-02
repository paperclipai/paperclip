import { api } from "./client";

export type ChatMode = "chat" | "agent";
export type PermissionMode = "ask" | "bypass";
export type EffortLevel = "auto" | "low" | "medium" | "high";

export interface ChatSession {
  id: string;
  boardUserId: string;
  companyId: string | null;
  title: string;
  model: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  effort: EffortLevel;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "user" | "assistant" | "tool";

export interface ChatContentBlockText {
  type: "text";
  text: string;
}
export interface ChatContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ChatContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
export type ChatContentBlock = ChatContentBlockText | ChatContentBlockToolUse | ChatContentBlockToolResult;

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatRole;
  content: ChatContentBlock[];
  createdAt: string;
}

export interface AvailableModel {
  provider: "anthropic" | "openai" | "ollama" | "gemini" | "adapter";
  model: string;
  source?: string;
}

export const chatApi = {
  listSessions: () => api.get<{ sessions: ChatSession[] }>("/chat/sessions"),
  getSession: (id: string) => api.get<{ session: ChatSession }>(`/chat/sessions/${id}`),
  createSession: (input: {
    title?: string;
    companyId?: string | null;
    mode?: ChatMode;
    permissionMode?: PermissionMode;
    model?: string;
  }) => api.post<{ session: ChatSession }>("/chat/sessions", input),
  patchSession: (
    id: string,
    patch: {
      title?: string;
      mode?: ChatMode;
      permissionMode?: PermissionMode;
      effort?: EffortLevel;
      companyId?: string | null;
      model?: string;
    },
  ) => api.patch<{ session: ChatSession }>(`/chat/sessions/${id}`, patch),
  deleteSession: (id: string) => api.delete<void>(`/chat/sessions/${id}`),
  listMessages: (id: string) =>
    api.get<{ messages: ChatMessage[] }>(`/chat/sessions/${id}/messages`),
  decidePermission: (sessionId: string, toolUseId: string, decision: "approve" | "deny") =>
    api.post<{ ok: true }>(`/chat/sessions/${sessionId}/permissions/${toolUseId}`, { decision }),
  listModels: () => api.get<{ models: AvailableModel[] }>("/chat/models"),
};
