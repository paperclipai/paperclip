import { api } from "./client";

export type ProviderConnectionStatus = {
  openai: {
    connected: boolean;
    secretId: string | null;
    latestVersion: number | null;
    updatedAt: string | null;
  };
  anthropic: {
    connected: boolean;
    secretId: string | null;
    latestVersion: number | null;
    updatedAt: string | null;
  };
};

export type ProviderName = "openai" | "anthropic";

export type ProviderConnectionResult = {
  ok: boolean;
  provider: ProviderName;
  stored?: boolean;
  mode?: "created" | "rotated";
  secretId?: string;
  latestVersion?: number;
  message: string;
};

export const providerConnectionsApi = {
  getStatus: (companyId: string) =>
    api.get<ProviderConnectionStatus>(`/companies/${companyId}/provider-connections`),
  connect: (
    companyId: string,
    input: { provider: ProviderName; apiKey: string; validateOnly?: boolean },
  ) =>
    api.post<ProviderConnectionResult>(`/companies/${companyId}/provider-connections`, input),
};
