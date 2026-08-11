export {
  execute,
  buildAntigravityArgs,
  resolveAntigravityMaxTokensPerRun,
  DEFAULT_ANTIGRAVITY_MAX_TOKENS_PER_RUN,
} from "./execute.js";
export { getConfigSchema } from "./config-schema.js";
export { listAntigravitySkills, syncAntigravitySkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  parseAntigravityOutput,
  inspectAntigravityStream,
  isAntigravityUnknownSessionError,
  detectAntigravityQuotaExhausted,
} from "./parse.js";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readNonEmptyString(record.sessionId) ??
      readNonEmptyString(record.conversationId) ??
      readNonEmptyString(record.conversation_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(record.cwd) ??
      readNonEmptyString(record.workdir) ??
      readNonEmptyString(record.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id);
    if (!sessionId) return null;
    const cwd =
      readNonEmptyString(params.cwd) ??
      readNonEmptyString(params.workdir) ??
      readNonEmptyString(params.folder);
    return {
      sessionId,
      ...(cwd ? { cwd } : {}),
    };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readNonEmptyString(params.sessionId) ??
      readNonEmptyString(params.conversationId) ??
      readNonEmptyString(params.conversation_id)
    );
  },
};
