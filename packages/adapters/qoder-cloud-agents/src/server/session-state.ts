import { asRecord, trimNullable, type QoderRepo } from "./shared.js";

export type QoderCloudAgentsSession = {
  qoderSessionId: string;
  qoderAgentId: string;
  managedAgent: boolean;
  environmentId: string;
  /** True when Paperclip picked the environment because none was configured. */
  environmentAutoSelected: boolean;
  apiBaseUrl: string;
  model?: string;
  repoUrl?: string;
  repoRef?: string;
  repoMountPath?: string;
  envFingerprint: string;
  /** Digest only. Qoder takes the repository token at session creation, so a new token needs a new session. */
  repoTokenFingerprint?: string;
};

export function readSession(params: Record<string, unknown> | null): QoderCloudAgentsSession | null {
  const record = asRecord(params);
  if (!record) return null;
  const qoderSessionId = trimNullable(record.qoderSessionId) ?? trimNullable(record.sessionId);
  const qoderAgentId = trimNullable(record.qoderAgentId);
  const environmentId = trimNullable(record.environmentId);
  const apiBaseUrl = trimNullable(record.apiBaseUrl);
  const envFingerprint = trimNullable(record.envFingerprint);
  if (!qoderSessionId || !qoderAgentId || !environmentId || !apiBaseUrl || !envFingerprint) return null;
  const model = trimNullable(record.model);
  const repoUrl = trimNullable(record.repoUrl);
  const repoRef = trimNullable(record.repoRef);
  const repoMountPath = trimNullable(record.repoMountPath);
  const repoTokenFingerprint = trimNullable(record.repoTokenFingerprint);
  return {
    qoderSessionId,
    qoderAgentId,
    managedAgent: record.managedAgent === true,
    environmentId,
    environmentAutoSelected: record.environmentAutoSelected === true,
    apiBaseUrl,
    ...(model ? { model } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(repoMountPath ? { repoMountPath } : {}),
    envFingerprint,
    ...(repoTokenFingerprint ? { repoTokenFingerprint } : {}),
  };
}

export function sessionMatches(
  session: QoderCloudAgentsSession | null,
  expected: {
    apiBaseUrl: string;
    configuredAgentId: string | null;
    configuredEnvironmentId: string | null;
    model: string;
    repo: QoderRepo | null;
    envFingerprint: string;
    repoTokenFingerprint: string | null;
  },
): boolean {
  if (!session) return false;
  if (session.apiBaseUrl !== expected.apiBaseUrl) return false;
  if (session.envFingerprint !== expected.envFingerprint) return false;
  if ((session.repoTokenFingerprint ?? null) !== (expected.repo ? expected.repoTokenFingerprint : null)) return false;
  if (expected.configuredAgentId) {
    if (session.qoderAgentId !== expected.configuredAgentId) return false;
  } else {
    // A Qoder session pins its agent snapshot, so a model change needs a new session.
    if (!session.managedAgent || session.model !== expected.model) return false;
  }
  if (expected.configuredEnvironmentId) {
    if (session.environmentId !== expected.configuredEnvironmentId) return false;
  } else if (!session.environmentAutoSelected) {
    // Clearing environmentId must leave a session that was pinned to an explicit environment.
    return false;
  }
  return (session.repoUrl ?? null) === (expected.repo?.url ?? null)
    && (session.repoRef ?? null) === (expected.repo?.ref ?? null)
    && (session.repoMountPath ?? null) === (expected.repo?.mountPath ?? null);
}
