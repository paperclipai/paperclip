import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * Minimal session codec for ollama_local.
 *
 * Chat-mode MVP carries no Ollama-side session state across heartbeats; we
 * accept an opaque sessionId pass-through so an upstream caller may still
 * persist a stable conversation id if they wish.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
    return sessionId ? { sessionId } : null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
    return sessionId ? { sessionId } : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return typeof params.sessionId === "string" && params.sessionId.trim().length > 0
      ? params.sessionId.trim()
      : null;
  },
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { listOllamaModels } from "./models.js";
