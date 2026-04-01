import type { ChatRoom, ChatMessage, ChatMessageAttachment } from "@paperclipai/shared";
import { api } from "./client";

export const chatApi = {
  listRooms: (companyId: string) =>
    api.get<ChatRoom[]>(`/companies/${encodeURIComponent(companyId)}/chat/rooms`),

  getOrCreateRoom: (companyId: string, data: { kind: "direct" | "boardroom"; agentId?: string }) =>
    api.post<ChatRoom>(`/companies/${encodeURIComponent(companyId)}/chat/rooms`, data),

  listMessages: (companyId: string, roomId: string, opts?: { before?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (opts?.before) params.set("before", opts.before);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return api.get<ChatMessage[]>(
      `/companies/${encodeURIComponent(companyId)}/chat/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ""}`,
    );
  },

  postMessage: (companyId: string, roomId: string, data: { body: string }) =>
    api.post<ChatMessage>(
      `/companies/${encodeURIComponent(companyId)}/chat/rooms/${encodeURIComponent(roomId)}/messages`,
      data,
    ),

  postMessageWithAttachment: (companyId: string, roomId: string, file: File, body?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (body) form.append("body", body);
    return api.postForm<ChatMessage & { attachments: ChatMessageAttachment[] }>(
      `/companies/${encodeURIComponent(companyId)}/chat/rooms/${encodeURIComponent(roomId)}/messages/with-attachment`,
      form,
    );
  },
};
