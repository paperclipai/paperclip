import type { SecretProvider, SecretProviderDescriptor } from "@paperclipai/shared";
import type { DeploymentMode } from "@paperclipai/shared";

export interface StoredSecretVersionMaterial {
  [key: string]: unknown;
}

export type SecretProviderHealthStatus = "ok" | "warn" | "error";

export interface SecretProviderHealthCheck {
  provider: SecretProvider;
  status: SecretProviderHealthStatus;
  message: string;
  warnings?: string[];
  backupGuidance?: string[];
  details?: Record<string, unknown>;
}

export interface SecretProviderValidationResult {
  ok: boolean;
  warnings: string[];
}

export interface PreparedSecretVersion {
  material: StoredSecretVersionMaterial;
  valueSha256: string;
  fingerprintSha256?: string;
  externalRef: string | null;
  providerVersionRef?: string | null;
}

export interface RemoteSecretListEntry {
  externalRef: string;
  name: string;
  providerVersionRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RemoteSecretListResult {
  secrets: RemoteSecretListEntry[];
  nextToken?: string | null;
}

export type SecretProviderClientErrorCode =
  | "access_denied"
  | "throttled"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "provider_unavailable"
  | "provider_error";

export interface SecretProviderClientErrorOptions {
  code: SecretProviderClientErrorCode;
  provider: SecretProvider;
  operation: string;
  message: string;
  status?: number;
  rawMessage?: string | null;
  cause?: unknown;
}

const SECRET_PROVIDER_CLIENT_ERROR_STATUS: Record<SecretProviderClientErrorCode, number> = {
  access_denied: 403,
  throttled: 429,
  not_found: 404,
  conflict: 409,
  invalid_request: 422,
  provider_unavailable: 503,
  provider_error: 502,
};

export class SecretProviderClientError extends Error {
  readonly code: SecretProviderClientErrorCode;
  readonly provider: SecretProvider;
  readonly operation: string;
  readonly status: number;
  readonly rawMessage: string | null;

  constructor(options: SecretProviderClientErrorOptions) {
    super(options.message);
    this.name = "SecretProviderClientError";
    this.code = options.code;
    this.provider = options.provider;
    this.operation = options.operation;
    this.status = options.status ?? SECRET_PROVIDER_CLIENT_ERROR_STATUS[options.code];
    this.rawMessage = options.rawMessage ?? null;
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

export function isSecretProviderClientError(error: unknown): error is SecretProviderClientError {
  return error instanceof SecretProviderClientError;
}

export interface SecretProviderRuntimeContext {
  companyId: string;
  secretId: string;
  secretKey: string;
  version: number;
}

export interface SecretProviderVaultRuntimeConfig {
  id: string;
  provider: SecretProvider;
  status: string;
  config: Record<string, unknown>;
}

export interface SecretProviderWriteContext {
  companyId: string;
  secretKey: string;
  secretName: string;
  version: number;
}

export interface SecretProviderModule {
  id: SecretProvider;
  descriptor(): SecretProviderDescriptor;
  validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult>;
  createSecret(input: {
    value: string;
    externalRef?: string | null;
    context?: SecretProviderWriteContext;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<PreparedSecretVersion>;
  createVersion(input: {
    value: string;
    externalRef?: string | null;
    context?: SecretProviderWriteContext;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<PreparedSecretVersion>;
  linkExternalSecret(input: {
    externalRef: string;
    providerVersionRef?: string | null;
    context?: SecretProviderWriteContext;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<PreparedSecretVersion>;
  listRemoteSecrets?(input: {
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
    query?: string | null;
    nextToken?: string | null;
    pageSize?: number;
  }): Promise<RemoteSecretListResult>;
  resolveVersion(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
    providerVersionRef?: string | null;
    context?: SecretProviderRuntimeContext;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<string>;
  rotate?(input: {
    material: StoredSecretVersionMaterial;
    externalRef: string | null;
    providerVersionRef?: string | null;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<PreparedSecretVersion>;
  deleteOrArchive(input: {
    material?: StoredSecretVersionMaterial | null;
    externalRef: string | null;
    context?: SecretProviderWriteContext;
    mode: "archive" | "delete";
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<void>;
  healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck>;
}
