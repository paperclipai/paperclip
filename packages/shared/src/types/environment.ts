import type {
  EnvironmentDriver,
  EnvironmentLeaseCleanupStatus,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  EnvironmentStatus,
} from "../constants.js";
import type { AgentEnvConfig, EnvSecretRefBinding } from "./secrets.js";

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

export type SandboxEnvironmentProvider = "fake" | (string & {});

export interface FakeSandboxEnvironmentConfig {
  provider: "fake";
  image: string;
  reuseLease: boolean;
  /** Stream agent CLI stdout/stderr during sandbox runs (bridge log-tail loop). */
  streamRunLogs?: boolean;
  /**
   * Archive the sandbox on lease release instead of deleting it, so operators
   * can inspect it from the provider dashboard. Injected by test/probe paths;
   * providers without archive support delete as usual.
   */
  archiveOnRelease?: boolean;
}

export interface PluginSandboxEnvironmentConfig {
  provider: SandboxEnvironmentProvider;
  reuseLease: boolean;
  timeoutMs?: number;
  /** Stream agent CLI stdout/stderr during sandbox runs (bridge log-tail loop). */
  streamRunLogs?: boolean;
  /**
   * Archive the sandbox on lease release instead of deleting it, so operators
   * can inspect it from the provider dashboard. Injected by test/probe paths;
   * providers without archive support delete as usual.
   */
  archiveOnRelease?: boolean;
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
  name: string;
  description: string | null;
  driver: EnvironmentDriver;
  status: EnvironmentStatus;
  config: Record<string, unknown>;
  envVars: AgentEnvConfig;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EnvironmentDeleteBlockedReason = "managed_local" | "instance_default";

export interface EnvironmentDeleteBlastRadius {
  environmentId: string;
  canDelete: boolean;
  deleteBlockedReasons: EnvironmentDeleteBlockedReason[];
  staticReferences: {
    isManagedLocal: boolean;
    isInstanceDefault: boolean;
    agentDefaultCount: number;
    executionWorkspaceSelectionCount: number;
    issueSelectionCount: number;
    projectSelectionCount: number;
    secretBindingCount: number;
  };
  activeRuntimeUse: {
    activeLeaseCount: number;
    activeCustomImageSetupSessionCount: number;
    hasActiveRuntimeUse: boolean;
  };
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
