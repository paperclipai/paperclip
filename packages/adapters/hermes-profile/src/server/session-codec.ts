import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export const hermesProfileSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
    const profile = typeof value.profile === "string" ? value.profile : undefined;
    if (!sessionId && !profile) return null;
    return { ...(profile ? { profile } : {}), ...(sessionId ? { sessionId } : {}) };
  },
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const profile = typeof params.profile === "string" ? params.profile : undefined;
    if (!sessionId && !profile) return null;
    return { ...(profile ? { profile } : {}), ...(sessionId ? { sessionId } : {}) };
  },
  getDisplayId(params: Record<string, unknown> | null): string | null {
    const profile = typeof params?.profile === "string" ? params.profile : null;
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
    if (profile && sessionId) return `${profile}:${sessionId.slice(0, 12)}`;
    return profile ?? (sessionId ? sessionId.slice(0, 16) : null);
  },
};
