import type {
  EnvironmentDriver,
  EnvironmentLeaseCleanupStatus,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  EnvironmentStatus,
} from "../constants.js";
import type { EnvSecretRefBinding } from "./secrets.js";

export interface LocalEnvironmentConfig {
  [key: string]: unknown;
}

export interface SshEnvironmentConfig {
  host: string;
  port: number;
  username: string;
  remoteWorkspacePath: string;
  privateKey: string | null;
  privateKeySecretRef: EnvSecretRefBinding | null;
  knownHosts: string | null;
  strictHostKeyChecking: boolean;
}

/**
 * Known sandbox environment provider keys.
 *
 * `"fake"` is a built-in test-only provider.
 *
 * Additional providers can be added by installing sandbox provider plugins
 * that declare matching `environmentDrivers` in their manifest. The type
 * includes `string` to allow plugin-backed providers without requiring
 * shared type changes.
 */
export type SandboxEnvironmentProvider = "fake" | (string & {});

export interface FakeSandboxEnvironmentConfig {
  provider: "fake";
  image: string;
  reuseLease: boolean;
}

export interface PluginSandboxEnvironmentConfig {
  provider: SandboxEnvironmentProvider;
  reuseLease: boolean;
  timeoutMs?: number;
  [key: string]: unknown;
}

export type SandboxEnvironmentConfig =
  | FakeSandboxEnvironmentConfig
  | PluginSandboxEnvironmentConfig;

export interface PluginEnvironmentConfig {
  pluginKey: string;
  driverKey: string;
  driverConfig: Record<string, unknown>;
}

export interface EnvironmentProbeResult {
  ok: boolean;
  driver: EnvironmentDriver;
  summary: string;
  details: Record<string, unknown> | null;
}

export interface Environment {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  driver: EnvironmentDriver;
  status: EnvironmentStatus;
  config: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentLease {
  id: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
  status: EnvironmentLeaseStatus;
  leasePolicy: EnvironmentLeasePolicy;
  provider: string | null;
  providerLeaseId: string | null;
  acquiredAt: Date;
  lastUsedAt: Date;
  expiresAt: Date | null;
  releasedAt: Date | null;
  failureReason: string | null;
  cleanupStatus: EnvironmentLeaseCleanupStatus | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
