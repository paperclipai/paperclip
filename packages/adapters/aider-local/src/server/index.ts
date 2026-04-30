export { execute } from "./execute.js";
export { testEnvironment, readAiderAuthStatus } from "./test.js";
export {
  parseAiderUsage,
  classifyAiderFailure,
  extractAiderSummary,
} from "./parse.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Aider stores its conversation in `.aider.chat.history.md` inside the cwd —
 * there is no opaque session id like Claude/Codex have. The codec just round-
 * trips cwd so resumed runs return to the same directory.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const cwd = readNonEmptyString(record.cwd);
    if (!cwd) return null;
    return { sessionId: cwd, cwd };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const cwd = readNonEmptyString(params.cwd) ?? readNonEmptyString(params.sessionId);
    if (!cwd) return null;
    return { sessionId: cwd, cwd };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.cwd) ?? readNonEmptyString(params.sessionId);
  },
};
