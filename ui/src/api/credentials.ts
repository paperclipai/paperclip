import type { CredentialType, ProviderCredentialQuota } from "@paperclipai/shared";
import { api } from "./client";

export interface ProviderCredential {
  id: string;
  companyId: string;
  name: string;
  type: CredentialType;
  isDefault: boolean;
  // Auto-rotation bookkeeping (see server credential rotator). `cooldownUntil`
  // is an ISO timestamp while the credential is parked after a failure.
  cooldownUntil: string | null;
  cooldownReason: string | null;
  lastUsedAt: string | null;
  // Escalating failover: count of consecutive credential-related failures, and
  // (when auto- or manually disabled) when/why it was parked out of the pool.
  consecutiveFailureCount: number;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialUsage {
  credentialId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costCents: number;
  events: number;
}

export interface RevealedCredential {
  credential: Record<string, unknown>;
}

export interface CodexCredDeviceAuthStartResponse {
  sessionId: string;
}

export interface CodexCredDeviceAuthPollResponse {
  status: "starting" | "awaiting_user" | "success" | "error";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  errorCode: "timeout" | "denied" | "device_code_disabled" | "infra" | null;
  // Populated ONCE on the first poll that observes status === "success".
  // The server wipes both this field and its on-disk copy as soon as it
  // returns the value, so the UI must immediately persist it via the
  // existing credential CREATE endpoint.
  authJson: string | null;
  stderr: string;
}

export const credentialsApi = {
  list: (companyId: string) =>
    api.get<ProviderCredential[]>(`/companies/${companyId}/credentials`),
  create: (
    companyId: string,
    data: {
      name: string;
      type: CredentialType;
      credential: Record<string, unknown>;
      isDefault?: boolean;
    },
  ) => api.post<ProviderCredential>(`/companies/${companyId}/credentials`, data),
  update: (
    id: string,
    data: {
      name?: string;
      credential?: Record<string, unknown>;
      isDefault?: boolean;
    },
  ) => api.patch<ProviderCredential>(`/credentials/${id}`, data),
  remove: (id: string, force = false) =>
    api.delete<{ ok: true }>(`/credentials/${id}${force ? "?force=true" : ""}`),
  reveal: (id: string) => api.get<RevealedCredential>(`/credentials/${id}/reveal`),
  usage: (companyId: string, days = 30) =>
    api.get<{ days: number; usage: CredentialUsage[] }>(
      `/companies/${companyId}/credentials/usage?days=${days}`,
    ),
  quotaWindows: (companyId: string) =>
    api.get<ProviderCredentialQuota[]>(`/companies/${companyId}/credentials/quota-windows`),
  test: (id: string) =>
    api.post<{ ok: boolean; message: string }>(`/credentials/${id}/test`, {}),
  reenable: (id: string) => api.post<ProviderCredential>(`/credentials/${id}/reenable`, {}),
  probe: (type: CredentialType, credential: Record<string, unknown>) =>
    api.post<{ ok: boolean; message: string }>(`/credentials/probe`, {
      type,
      credential,
    }),
  startCodexDeviceAuth: (companyId: string) =>
    api.post<CodexCredDeviceAuthStartResponse>(
      `/companies/${companyId}/credentials/codex/device-auth-start`,
      {},
    ),
  pollCodexDeviceAuth: (companyId: string, sessionId: string) =>
    api.get<CodexCredDeviceAuthPollResponse>(
      `/companies/${companyId}/credentials/codex/device-auth-poll/${encodeURIComponent(sessionId)}`,
    ),
};
