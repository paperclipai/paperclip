import type {
  CompanySecret,
  CompanySecretUsageBinding,
  CompanySecretProviderConfig,
  RemoteSecretImportPreviewResult,
  RemoteSecretImportResult,
  SecretAccessEvent,
  SecretManagedMode,
  SecretProvider,
  SecretProviderConfigStatus,
  SecretProviderConfigHealthResponse,
  SecretProviderDescriptor,
  SecretStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export interface SecretUsageResponse {
  secretId: string;
  bindings: CompanySecretUsageBinding[];
}

export interface CreateSecretInput {
  name: string;
  key?: string;
  provider?: SecretProvider;
  managedMode?: SecretManagedMode;
  value?: string | null;
  description?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerConfigId?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface SecretProviderHealthResponse {
  providers: Array<{
    provider: SecretProvider;
    status: "ok" | "warn" | "error";
    message: string;
    warnings?: string[];
    backupGuidance?: string[];
    details?: Record<string, unknown>;
  }>;
}

export interface UpdateSecretInput {
  name?: string;
  key?: string;
  status?: SecretStatus;
  description?: string | null;
  externalRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface RotateSecretInput {
  value?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
  providerConfigId?: string | null;
}

export interface CreateSecretProviderConfigInput {
  provider: SecretProvider;
  displayName: string;
  status?: SecretProviderConfigStatus;
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateSecretProviderConfigInput {
  displayName?: string;
  status?: SecretProviderConfigStatus;
  isDefault?: boolean;
  config?: Record<string, unknown>;
}

export interface RemoteImportPreviewInput {
  providerConfigId: string;
  query?: string | null;
  nextToken?: string | null;
  pageSize?: number;
}

export interface RemoteImportSelectionInput {
  externalRef: string;
  name?: string | null;
  key?: string | null;
  description?: string | null;
  providerVersionRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}

export interface RemoteImportInput {
  providerConfigId: string;
  secrets: RemoteImportSelectionInput[];
}

export const secretsApi = {
  list: (companyId: string) => api.get<CompanySecret[]>(`/companies/${companyId}/secrets`),
  providers: (companyId: string) =>
    api.get<SecretProviderDescriptor[]>(`/companies/${companyId}/secret-providers`),
  providerHealth: (companyId: string) =>
    api.get<SecretProviderHealthResponse>(`/companies/${companyId}/secret-providers/health`),
  providerConfigs: (companyId: string) =>
    api.get<CompanySecretProviderConfig[]>(`/companies/${companyId}/secret-provider-configs`),
  createProviderConfig: (companyId: string, data: CreateSecretProviderConfigInput) =>
    api.post<CompanySecretProviderConfig>(`/companies/${companyId}/secret-provider-configs`, data),
  updateProviderConfig: (id: string, data: UpdateSecretProviderConfigInput) =>
    api.patch<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`, data),
  disableProviderConfig: (id: string) =>
    api.delete<CompanySecretProviderConfig>(`/secret-provider-configs/${id}`),
  setDefaultProviderConfig: (id: string) =>
    api.post<CompanySecretProviderConfig>(`/secret-provider-configs/${id}/default`, {}),
  checkProviderConfigHealth: (id: string) =>
    api.post<SecretProviderConfigHealthResponse>(`/secret-provider-configs/${id}/health`, {}),
  create: (companyId: string, data: CreateSecretInput) =>
    api.post<CompanySecret>(`/companies/${companyId}/secrets`, data),
  update: (id: string, data: UpdateSecretInput) =>
    api.patch<CompanySecret>(`/secrets/${id}`, data),
  rotate: (id: string, data: RotateSecretInput) =>
    api.post<CompanySecret>(`/secrets/${id}/rotate`, data),
  disable: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "disabled" satisfies SecretStatus }),
  enable: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "active" satisfies SecretStatus }),
  archive: (id: string) =>
    api.patch<CompanySecret>(`/secrets/${id}`, { status: "archived" satisfies SecretStatus }),
  remove: (id: string) => api.delete<{ ok: true }>(`/secrets/${id}`),
  usage: (id: string) => api.get<SecretUsageResponse>(`/secrets/${id}/usage`),
  accessEvents: (id: string) => api.get<SecretAccessEvent[]>(`/secrets/${id}/access-events`),
  remoteImportPreview: (companyId: string, data: RemoteImportPreviewInput) =>
    api.post<RemoteSecretImportPreviewResult>(
      `/companies/${companyId}/secrets/remote-import/preview`,
      data,
    ),
  remoteImport: (companyId: string, data: RemoteImportInput) =>
    api.post<RemoteSecretImportResult>(`/companies/${companyId}/secrets/remote-import`, data),
};
