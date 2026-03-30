import type { ProviderCredential } from "@paperclipai/shared";
import { api } from "./client";

export const credentialsApi = {
  list: (companyId: string) =>
    api.get<ProviderCredential[]>(`/companies/${companyId}/credentials`),

  create: (
    companyId: string,
    data: {
      name: string;
      type: string;
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

  remove: (id: string) => api.delete<{ ok: true }>(`/credentials/${id}`),

  // Claude OAuth login flow
  startClaudeLogin: (
    companyId: string,
    data?: { name?: string; isDefault?: boolean },
  ) =>
    api.post<{ loginSessionId: string; loginUrl: string | null }>(
      `/companies/${companyId}/credentials/claude-login`,
      data ?? {},
    ),

  pollClaudeLogin: (companyId: string, sessionId: string) =>
    api.get<{
      status: "pending" | "complete" | "failed" | "expired";
      loginUrl: string | null;
      credentialId?: string;
      error?: string;
    }>(`/companies/${companyId}/credentials/claude-login/${sessionId}/status`),

  cancelClaudeLogin: (companyId: string, sessionId: string) =>
    api.delete<{ ok: boolean }>(
      `/companies/${companyId}/credentials/claude-login/${sessionId}`,
    ),
};
