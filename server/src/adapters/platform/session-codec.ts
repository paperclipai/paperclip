/**
 * Session Codec for Platform Adapter
 *
 * Handles serialization/deserialization of platform agent session state
 */

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface PlatformSessionState {
  conversationId?: string;
  messageCount?: number;
  lastLlmCallAt?: number;
  toolCallHistory?: Array<{
    tool: string;
    args: unknown;
    result: unknown;
  }>;
}

export const platformSessionCodec: AdapterSessionCodec = {
  deserialize: (encoded: unknown): Record<string, unknown> | null => {
    if (!encoded || typeof encoded !== "object") {
      return null;
    }

    const state = encoded as Record<string, unknown>;
    return {
      conversationId:
        typeof state.conversationId === "string" ? state.conversationId : undefined,
      messageCount:
        typeof state.messageCount === "number" ? state.messageCount : undefined,
      lastLlmCallAt:
        typeof state.lastLlmCallAt === "number" ? state.lastLlmCallAt : undefined,
      toolCallHistory: Array.isArray(state.toolCallHistory)
        ? (state.toolCallHistory as unknown[]).filter(
            (item) =>
              item &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).tool === "string",
          )
        : undefined,
    };
  },

  serialize: (state: Record<string, unknown> | null): Record<string, unknown> | null => {
    if (!state || typeof state !== "object") return null;
    return {
      conversationId: state.conversationId,
      messageCount: state.messageCount,
      lastLlmCallAt: state.lastLlmCallAt,
      toolCallHistory: state.toolCallHistory,
    };
  },
};
