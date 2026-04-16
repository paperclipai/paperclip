import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export { execute } from "./execute.js";
export type { BrowserTool, BrowserToolCall, BrowserToolResult } from "./tools/types.js";
export { redactDomHtml, redactScreenshotRegions } from "./tools/redaction.js";
export { tokenizeSecrets, resolveSecretToken } from "./tools/secrets.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ?? readNonEmptyString(record.session_id);
    if (!sessionId) return null;
    const profileDir = readNonEmptyString(record.profileDir);
    const socketPath = readNonEmptyString(record.socketPath);
    return {
      sessionId,
      ...(profileDir ? { profileDir } : {}),
      ...(socketPath ? { socketPath } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
    if (!sessionId) return null;
    const profileDir = readNonEmptyString(params.profileDir);
    const socketPath = readNonEmptyString(params.socketPath);
    return {
      sessionId,
      ...(profileDir ? { profileDir } : {}),
      ...(socketPath ? { socketPath } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
