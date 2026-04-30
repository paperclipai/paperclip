import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

/**
 * v1 session codec — stateless.
 *
 * Ollama's /api/chat is stateless by design on the server side (`context`
 * arrays are only returned by /api/generate, never /api/chat). We keep the
 * codec scaffold so the server's session-compaction glue still calls us,
 * but we never persist anything; every heartbeat rebuilds the full
 * transcript from scratch via server/execute.ts#buildTranscript.
 *
 * v1.1 may store a compaction summary here. For now, always return null
 * so Paperclip knows there is no session state to resume.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(_raw: unknown) {
    return null;
  },
  serialize(_params: Record<string, unknown> | null) {
    return null;
  },
  getDisplayId(_params: Record<string, unknown> | null) {
    return null;
  },
};
