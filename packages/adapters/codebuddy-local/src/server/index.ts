import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId = readString(record.sessionId) ?? readString(record.session_id);
    if (!sessionId) return null;
    const cwd = readString(record.cwd);
    const remoteExecution =
      typeof record.remoteExecution === "object" && record.remoteExecution !== null
        ? record.remoteExecution
        : undefined;
    return { sessionId, ...(cwd ? { cwd } : {}), ...(remoteExecution ? { remoteExecution } : {}) };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId = readString(params.sessionId) ?? readString(params.session_id);
    if (!sessionId) return null;
    const cwd = readString(params.cwd);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
      ...(params.remoteExecution ? { remoteExecution: params.remoteExecution } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return params ? readString(params.sessionId) ?? readString(params.session_id) : null;
  },
};

export { execute } from "./execute.js";
export { listCodeBuddySkills, syncCodeBuddySkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  describeCodeBuddyFailure,
  isCodeBuddyUnknownSessionError,
  parseCodeBuddyStreamJson,
} from "./parse.js";
