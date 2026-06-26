import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute, resolveSessionKey, parseSseFramesForTest, mapFinalResultForTest } from "./execute.js";
export { testEnvironment } from "./test.js";
export { getConfigSchema } from "./config-schema.js";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const hermesSessionId = readString(record.hermesSessionId) ?? readString(record.sessionId);
    const sessionKey = readString(record.sessionKey);
    const hermesRunId = readString(record.hermesRunId);
    const strategy = readString(record.strategy);
    if (!hermesSessionId && !sessionKey && !hermesRunId) return null;
    return {
      ...(hermesRunId ? { hermesRunId } : {}),
      ...(hermesSessionId ? { hermesSessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(strategy ? { strategy } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const hermesSessionId = readString(params.hermesSessionId) ?? readString(params.sessionId);
    const sessionKey = readString(params.sessionKey);
    const hermesRunId = readString(params.hermesRunId);
    const strategy = readString(params.strategy);
    if (!hermesSessionId && !sessionKey && !hermesRunId) return null;
    return {
      ...(hermesRunId ? { hermesRunId } : {}),
      ...(hermesSessionId ? { hermesSessionId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(strategy ? { strategy } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.hermesSessionId) ?? readString(params.sessionKey) ?? readString(params.hermesRunId);
  },
};

