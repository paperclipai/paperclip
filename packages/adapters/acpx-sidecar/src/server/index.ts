export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionName = readNonEmptyString(record.sessionName) ?? readNonEmptyString(record.session_name);
    const sessionId = readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    const cwd = readNonEmptyString(record.cwd);
    return sessionName || sessionId
      ? {
          ...(sessionName ? { sessionName } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(cwd ? { cwd } : {}),
        }
      : null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionName = readNonEmptyString(params.sessionName) ?? readNonEmptyString(params.session_name);
    const sessionId = readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    const cwd = readNonEmptyString(params.cwd);
    return sessionName || sessionId
      ? {
          ...(sessionName ? { sessionName } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(cwd ? { cwd } : {}),
        }
      : null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionName) ?? readNonEmptyString(params.sessionId) ?? null;
  },
};
