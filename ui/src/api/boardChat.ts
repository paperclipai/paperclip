import type { Issue } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Conference Room (board chat) transport. The room is backed by an ordinary
 * company-scoped `board_chat` issue so history survives reloads; the real
 * agent conversation runs over `AssistantChat` (PAP-11099 Phase 3b).
 */
export const boardChatApi = {
  /**
   * Resolve-or-create the standing `board_chat` conversation issue for a
   * company and return it. The web client can't mint the issue itself because
   * `originKind` is stripped by the issue create schema, so the server owns
   * this. `newConversation: true` forces a fresh conversation (the room's
   * "New chat" control). Backend: `POST /api/board/chat/conversations`.
   */
  resolveConversation: (
    companyId: string,
    options?: { newConversation?: boolean },
  ) =>
    api.post<{ issue: Issue }>("/board/chat/conversations", {
      companyId,
      ...(options?.newConversation ? { newConversation: true } : {}),
    }),
  getConversation: (companyId: string, conversationRef: string) => {
    const params = new URLSearchParams({ companyId });
    return api.get<{
      issue: Issue | null;
      unavailableReason: "not_found" | "wrong_company" | "wrong_kind" | "cancelled" | null;
    }>(`/board/chat/conversations/${encodeURIComponent(conversationRef)}?${params.toString()}`);
  },
};
