import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Pass-through codec. qwen-code session ids are opaque strings persisted on
// disk via --chat-recording; the adapter does not yet round-trip them across
// runs (Phase 2.5 follow-up) but we still expose serialize/deserialize so the
// server's session storage layer can persist whatever execute() returns.
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(record.cwd);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const cwd = readNonEmptyString(params.cwd);
    return { sessionId, ...(cwd ? { cwd } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};

export { execute } from "./execute.js";
export {
  parseQwenStreamLine,
  parseQwenStreamBuffer,
  aggregateUsage,
  collectText,
  findSessionId,
  findError,
} from "./parse.js";
export type { QwenStreamEvent } from "./parse.js";
export {
  prepareQwenRuntimeConfig,
  resolveQwenConfig,
  QwenAdapterConfigError,
} from "./runtime-config.js";
export { testEnvironment } from "./test.js";
export { listQwenModels, requireQwenModelId } from "./models.js";
