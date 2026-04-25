import type { CompanySecret, SecretProviderDescriptor, SecretProvider } from "@paperclipai/shared";
import { api } from "./client";

export const secretsApi = {
  list: (companyId: string) => api.get<CompanySecret[]>(`/companies/${companyId}/secrets`),
  providers: (companyId: string) =>
    api.get<SecretProviderDescriptor[]>(`/companies/${companyId}/secret-providers`),
  create: (
    companyId: string,
    data: {
      name: string;
      value: string;
      provider?: SecretProvider;
      description?: string | null;
      externalRef?: string | null;
    },
  ) => api.post<CompanySecret>(`/companies/${companyId}/secrets`, data),
  rotate: (id: string, data: { value: string; externalRef?: string | null }) =>
    api.post<CompanySecret>(`/secrets/${id}/rotate`, data),
  update: (
    id: string,
    data: { name?: string; description?: string | null; externalRef?: string | null },
  ) => api.patch<CompanySecret>(`/secrets/${id}`, data),
  remove: (id: string) => api.delete<{ ok: true }>(`/secrets/${id}`),
};

/**
 * Instance-scoped secrets — single global namespace, gated on instance-admin
 * auth. Per-id mutations (rotate / update / remove) reuse the existing
 * `/api/secrets/:id/*` routes; the backend dispatches by stored scope.
 */
export const instanceSecretsApi = {
  list: () => api.get<CompanySecret[]>(`/instance/secrets`),
  providers: () => api.get<SecretProviderDescriptor[]>(`/instance/secret-providers`),
  create: (data: {
    name: string;
    value: string;
    provider?: SecretProvider;
    description?: string | null;
    externalRef?: string | null;
  }) => api.post<CompanySecret>(`/instance/secrets`, data),
};
