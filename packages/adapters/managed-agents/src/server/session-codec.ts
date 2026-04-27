import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Persists agentId + environmentId + sessionId so subsequent runs reuse objects
// instead of creating a fresh agent/env for every invocation (which would bump
// Anthropic resource quotas hard).
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const sessionId = readString(r.sessionId) ?? readString(r.session_id);
    const agentId = readString(r.agentId) ?? readString(r.agent_id);
    const environmentId = readString(r.environmentId) ?? readString(r.environment_id);
    const agentVersion = typeof r.agentVersion === "number" ? r.agentVersion : null;
    if (!sessionId && !agentId && !environmentId) return null;
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(agentVersion ? { agentVersion } : {}),
    };
  },
  serialize(params) {
    if (!params) return null;
    const sessionId = readString(params.sessionId);
    const agentId = readString(params.agentId);
    const environmentId = readString(params.environmentId);
    const agentVersion = typeof params.agentVersion === "number" ? params.agentVersion : null;
    if (!sessionId && !agentId && !environmentId) return null;
    return {
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(agentVersion ? { agentVersion } : {}),
    };
  },
  getDisplayId(params) {
    if (!params) return null;
    return readString(params.sessionId) ?? readString(params.agentId);
  },
};
