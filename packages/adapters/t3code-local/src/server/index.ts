import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const threadId = readNonEmptyString(record.threadId);
  if (!threadId) return null;
  const cwd = readNonEmptyString(record.cwd);
  return { threadId, ...(cwd ? { cwd } : {}) };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId: (params) => readNonEmptyString(params?.threadId),
};

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { parseT3RunResult } from "./parse.js";
