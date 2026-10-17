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
  const qoderSessionId = readString(record.qoderSessionId) ?? readString(record.sessionId);
  if (!qoderSessionId) return null;
  const qoderAgentId = readString(record.qoderAgentId);
  const environmentId = readString(record.environmentId);
  const apiBaseUrl = readString(record.apiBaseUrl);
  const model = readString(record.model);
  const repoUrl = readString(record.repoUrl);
  const repoRef = readString(record.repoRef);
  const repoMountPath = readString(record.repoMountPath);
  const envFingerprint = readString(record.envFingerprint);
  const repoTokenFingerprint = readString(record.repoTokenFingerprint);
  return {
    qoderSessionId,
    ...(qoderAgentId ? { qoderAgentId } : {}),
    managedAgent: record.managedAgent === true,
    environmentAutoSelected: record.environmentAutoSelected === true,
    ...(environmentId ? { environmentId } : {}),
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(model ? { model } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(repoMountPath ? { repoMountPath } : {}),
    ...(envFingerprint ? { envFingerprint } : {}),
    ...(repoTokenFingerprint ? { repoTokenFingerprint } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize: normalize,
  serialize: normalize,
  getDisplayId(params) {
    const normalized = normalize(params);
    return normalized ? String(normalized.qoderSessionId) : null;
  },
};
