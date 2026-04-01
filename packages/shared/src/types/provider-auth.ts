import type { KnownProviderCredentialProvider } from "../constants.js";

export type ProviderCredentialProvider = KnownProviderCredentialProvider | (string & {});

export interface ProviderCredentialSummary {
  id: string;
  companyId: string;
  provider: ProviderCredentialProvider;
  envKey: string;
  label: string;
  secretId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  secretName: string;
  secretLatestVersion: number;
  secretUpdatedAt: Date;
}

export interface ProviderCredentialProviderGroup {
  provider: ProviderCredentialProvider;
  credentials: ProviderCredentialSummary[];
  defaultCredentialId: string | null;
}

export interface LegacyProviderConnectionStatus {
  connected: boolean;
  secretId: string | null;
  latestVersion: number | null;
  updatedAt: Date | null;
}

export interface ProviderConnectionStatus {
  providers: ProviderCredentialProviderGroup[];
  openai: LegacyProviderConnectionStatus;
  anthropic: LegacyProviderConnectionStatus;
}

export interface ProviderCredentialValidationResult {
  ok: boolean;
  message: string;
}

export interface ProviderConnectionResult {
  ok: boolean;
  provider: ProviderCredentialProvider;
  envKey: string;
  label: string;
  stored: boolean;
  mode?: "created" | "rotated";
  secretId?: string;
  latestVersion?: number;
  credentialId?: string;
  message: string;
}

export type AdapterAuthRequirementSource = "fixed_adapter" | "provider_model" | "manual_env_key";

export type AdapterAuthResolutionSource = "adapter_env" | "default_credential" | "unresolved";

export interface AdapterAuthRequirementStatus {
  requirementId: string;
  source: AdapterAuthRequirementSource;
  provider: string | null;
  requiredEnvKeys: string[];
  resolved: boolean;
  resolvedBy: AdapterAuthResolutionSource;
  resolvedEnvKey: string | null;
  resolvedCredentialId: string | null;
  availableCredentials: ProviderCredentialSummary[];
  defaultCredentialId: string | null;
  unresolvedReason: string | null;
}

export interface AdapterAuthStatusResponse {
  adapterType: string;
  requirements: AdapterAuthRequirementStatus[];
  unresolvedCount: number;
  status: "resolved" | "unresolved";
}
