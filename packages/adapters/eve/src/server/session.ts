import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalize(raw: unknown): Record<string, unknown> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const eveSessionId = readString(record.eveSessionId) ?? readString(record.sessionId);
  if (!eveSessionId) return null;
  const continuationToken = readString(record.continuationToken);
  const rawIndex = record.eventIndex;
  const eventIndex =
    typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex >= 0
      ? Math.floor(rawIndex)
      : 0;
  return {
    eveSessionId,
    ...(continuationToken ? { continuationToken } : {}),
    eventIndex,
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    const normalized = normalize(params);
    return normalized ? String(normalized.eveSessionId) : null;
  },
};
