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
