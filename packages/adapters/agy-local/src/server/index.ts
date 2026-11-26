import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSession(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const sessionId =
    readNonEmptyString(record.sessionId) ??
    readNonEmptyString(record.session_id) ??
    readNonEmptyString(record.conversationId) ??
    readNonEmptyString(record.conversation_id);
  if (!sessionId) return null;
  const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir);
  const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: readSession,
  serialize(params: Record<string, unknown> | null) {
    return readSession(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readSession(params)?.sessionId as string | null ?? null;
  },
};

export { execute } from "./execute.js";
export { listAgySkills, syncAgySkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export { parseAgyStreamJson, isAgyUnknownSessionError, shouldRetryFreshConversation, detectAgyAuthRequired } from "./parse.js";
