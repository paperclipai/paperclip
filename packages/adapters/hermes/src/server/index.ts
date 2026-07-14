/**
 * Server-side adapter module exports.
 */

export { execute } from "./execute.js";
export { testEnvironment } from "./test.js";
export { detectModel, parseModelFromConfig, resolveProvider, inferProviderFromModel } from "./detect-model.js";
export { getConfigSchema } from "./config-schema.js";
export {
  listHermesSkills as listSkills,
  syncHermesSkills as syncSkills,
  resolveHermesDesiredSkillNames as resolveDesiredSkillNames,
} from "./skills.js";

import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

import { isCanonicalHermesSessionId } from "../shared/constants.js";

function readCanonicalSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return isCanonicalHermesSessionId(sessionId) ? sessionId : null;
}

/**
 * Session codec for structured validation and migration of session parameters.
 *
 * Hermes Agent uses a single `sessionId` for cross-heartbeat session continuity
 * via the `--resume` CLI flag. The codec validates and normalizes this field.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const sessionId =
      readCanonicalSessionId(record.sessionId) ??
      readCanonicalSessionId(record.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const sessionId =
      readCanonicalSessionId(params.sessionId) ??
      readCanonicalSessionId(params.session_id);
    if (!sessionId) return null;
    return { sessionId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readCanonicalSessionId(params.sessionId) ??
      readCanonicalSessionId(params.session_id)
    );
  },
};
