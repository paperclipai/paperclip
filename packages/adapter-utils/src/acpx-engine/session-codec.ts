import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const runtimeSessionName = readString(record.runtimeSessionName);
    const acpSessionId = readString(record.acpSessionId);
    const agentSessionId = readString(record.agentSessionId);
    const remoteExecution = readRecord(record.remoteExecution);
    if (!runtimeSessionName && !acpSessionId && !agentSessionId) return null;

    return {
      ...(runtimeSessionName ? { runtimeSessionName } : {}),
      ...(readString(record.sessionKey) ? { sessionKey: readString(record.sessionKey) } : {}),
      ...(readString(record.acpxRecordId) ? { acpxRecordId: readString(record.acpxRecordId) } : {}),
      ...(acpSessionId ? { acpSessionId } : {}),
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(readString(record.agent) ? { agent: readString(record.agent) } : {}),
      ...(readString(record.cwd) ? { cwd: readString(record.cwd) } : {}),
      ...(readString(record.mode) ? { mode: readString(record.mode) } : {}),
      ...(readString(record.stateDir) ? { stateDir: readString(record.stateDir) } : {}),
      ...(readString(record.configFingerprint) ? { configFingerprint: readString(record.configFingerprint) } : {}),
      ...(readString(record.workspaceId) ? { workspaceId: readString(record.workspaceId) } : {}),
      ...(readString(record.repoUrl) ? { repoUrl: readString(record.repoUrl) } : {}),
      ...(readString(record.repoRef) ? { repoRef: readString(record.repoRef) } : {}),
      ...(remoteExecution ? { remoteExecution } : {}),
    };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return this.deserialize(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return (
      readString(params.runtimeSessionName) ??
      readString(params.acpSessionId) ??
      readString(params.agentSessionId)
    );
  },
};
