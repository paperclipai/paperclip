import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type AgentskyCloudSession = {
  agentSlug: string;
  sessionId: string;
  harness: string;
  model: string;
  apiBaseUrl?: string;
  lastEventCursor?: string;
  attached?: boolean;
};

export function normalizeAgentskySession(raw: unknown): AgentskyCloudSession | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId = readString(record.sessionId);
  const agentSlug = readString(record.agentSlug);
  if (!sessionId || !agentSlug) return null;
  const harness = readString(record.harness) ?? "";
  const model = readString(record.model) ?? "";
  const apiBaseUrl = readString(record.apiBaseUrl);
  const lastEventCursor = readString(record.lastEventCursor);
  return {
    agentSlug,
    sessionId,
    harness,
    model,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(lastEventCursor ? { lastEventCursor } : {}),
    ...(record.attached === true ? { attached: true } : {}),
  };
}

function normalize(raw: unknown): Record<string, unknown> | null {
  return normalizeAgentskySession(raw);
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    const normalized = normalizeAgentskySession(params);
    return normalized ? normalized.sessionId : null;
  },
};
