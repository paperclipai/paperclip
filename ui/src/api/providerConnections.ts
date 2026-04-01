import type { AdapterAuthStatusResponse } from "@paperclipai/shared";
import { api } from "./client";

export type ProviderCredential = {
  id: string;
  companyId: string;
  provider: string;
  envKey: string;
  label: string;
  secretId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  secretName: string;
  secretLatestVersion: number;
  secretUpdatedAt: string;
};

export type ProviderCredentialGroup = {
  provider: string;
  credentials: ProviderCredential[];
  defaultCredentialId: string | null;
};

export type LegacyProviderConnectionStatus = {
  connected: boolean;
  secretId: string | null;
  latestVersion: number | null;
  updatedAt: string | null;
};

export type ProviderConnectionStatus = {
  providers: ProviderCredentialGroup[];
  knownProviders: string[];
  openai: LegacyProviderConnectionStatus;
  anthropic: LegacyProviderConnectionStatus;
};

export type ProviderName = string;

export type ProviderConnectionResult = {
  ok: boolean;
  provider: ProviderName;
  envKey: string;
  label: string;
  stored?: boolean;
  mode?: "created" | "rotated";
  credentialId?: string;
  secretId?: string;
  latestVersion?: number;
  message: string;
};

export const providerConnectionsApi = {
  getStatus: (companyId: string) =>
    api.get<ProviderConnectionStatus>(`/companies/${companyId}/provider-connections`),
  connect: (
    companyId: string,
    input: {
      provider: ProviderName;
      apiKey: string;
      validateOnly?: boolean;
      label?: string;
      envKey?: string;
      isDefault?: boolean;
    },
  ) =>
    api.post<ProviderConnectionResult>(`/companies/${companyId}/provider-connections`, input),
  createCredential: (
    companyId: string,
    input: {
      provider: ProviderName;
      envKey: string;
      label: string;
      apiKey: string;
      validateOnly?: boolean;
      isDefault?: boolean;
    },
  ) =>
    api.post<ProviderCredential>(`/companies/${companyId}/provider-connections/credentials`, input),
  updateCredential: (
    companyId: string,
    credentialId: string,
    input: { label?: string; isDefault?: boolean },
  ) =>
    api.patch<ProviderCredential>(
      `/companies/${companyId}/provider-connections/credentials/${credentialId}`,
      input,
    ),
  rotateCredential: (
    companyId: string,
    credentialId: string,
    input: { apiKey: string; validateOnly?: boolean },
  ) =>
    api.post<ProviderCredential>(
      `/companies/${companyId}/provider-connections/credentials/${credentialId}/rotate`,
      input,
    ),
  deleteCredential: (companyId: string, credentialId: string) =>
    api.delete<{ ok: true; id: string }>(
      `/companies/${companyId}/provider-connections/credentials/${credentialId}`,
    ),
  getAdapterAuthStatus: (
    companyId: string,
    input: { adapterType: string; adapterConfig?: Record<string, unknown> },
  ) =>
    api.post<AdapterAuthStatusResponse>(
      `/companies/${companyId}/provider-connections/adapter-auth-status`,
      input,
    ),
};
