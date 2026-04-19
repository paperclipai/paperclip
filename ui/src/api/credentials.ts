import type { CredentialType } from "@paperclipai/shared";
import { api } from "./client";

export interface ProviderCredential {
  id: string;
  companyId: string;
  name: string;
  type: CredentialType;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RevealedCredential {
  credential: Record<string, unknown>;
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
  test: (id: string) =>
    api.post<{ ok: boolean; message: string }>(`/credentials/${id}/test`, {}),
};
