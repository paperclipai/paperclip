export { execute } from "./execute.js";
export { listClaudeSkills as listSkills, syncClaudeSkills as syncSkills } from "./skills.js";
export { testEnvironment } from "./test.js";
export {
  parseClaudeStreamJson,
  describeClaudeFailure,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
  parseLocalLLMResponse,
} from "./parse.js";
export {
  getQuotaWindows,
  readClaudeAuthStatus,
  readClaudeToken,
  fetchClaudeQuota,
  fetchClaudeCliQuota,
} from "./quota.js";
export { listLMStudioModels } from "./lmstudio.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Session codec for local_local:
 * - Claude model runs produce session state (session id, cwd, workspace info)
 * - LM Studio runs are stateless (clearSession: true), so no session to persist
 * - We delegate to Claude's session codec for deserialization/serialization
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    return claudeSessionCodec.deserialize(raw);
  },
  serialize(params: Record<string, unknown> | null) {
    return claudeSessionCodec.serialize(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    const claudeDisplay = claudeSessionCodec.getDisplayId?.(params);
    if (claudeDisplay) return claudeDisplay;
    return readNonEmptyString(params.sessionId) ?? readNonEmptyString(params.session_id);
  },
};
