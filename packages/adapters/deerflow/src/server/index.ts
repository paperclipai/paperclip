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
    const threadId = readNonEmptyString(record.threadId) ?? readNonEmptyString(record.thread_id);
    if (!threadId) return null;
    return { threadId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const threadId = readNonEmptyString(params.threadId) ?? readNonEmptyString(params.thread_id);
    if (!threadId) return null;
    return { threadId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.threadId) ?? readNonEmptyString(params.thread_id);
  },
};
