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
  /** Override the paperclip_runner lifecycle for this environment. */
  runnerLifecycleMode?: "inherit" | "per_turn" | "warm";
  /** Warm runner idle timeout in milliseconds when runnerLifecycleMode is warm. */
  runnerIdleTimeoutMs?: number;
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
  /** Override the paperclip_runner lifecycle for this environment. */
  runnerLifecycleMode?: "inherit" | "per_turn" | "warm";
  /** Warm runner idle timeout in milliseconds when runnerLifecycleMode is warm. */
  runnerIdleTimeoutMs?: number;
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

export type EnvironmentDeleteBlockedReason =
  | "managed_local"
  | "instance_default"
  | "reusable_sandbox_lease"
  | "pending_sandbox_cleanup";

/**
 * One reusable sandbox lease that blocks an environment delete, with the
 * workspace/issue that holds it. Closing the workspace (or removing the issue)
 * lets Paperclip destroy the sandbox and release the lease. The workspace and
 * issue references are nullable because the lease FKs use `on delete set null`.
 */
export interface EnvironmentDeleteReusableLeaseHolder {
  leaseId: string;
  executionWorkspaceId: string | null;
  executionWorkspaceName: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
}

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
  /**
   * Count of leases in the terminal `pending_cleanup` state. Each such lease
   * holds the only durable provider reference for a sandbox that a teardown
   * retry must destroy. A delete or a provider change must not remove this
   * reference, so a count above zero blocks the delete.
   */
  pendingCleanupLeaseCount: number;
  /**
   * Count of reusable sandbox leases whose provider resource is still live.
   * Deleting the environment would remove the context used by their normal
   * release and destroy paths, so these leases block deletion.
   */
  reusableSandboxLeaseCount: number;
  /**
   * One entry per lease behind `reusableSandboxLeaseCount`, so a client can
   * name the blocking workspaces/issues instead of reporting a bare count.
   * Several leases can share one workspace.
   */
  reusableSandboxLeaseHolders: EnvironmentDeleteReusableLeaseHolder[];
}

export interface EnvironmentLease {
  id: string;
  companyId: string;
  // Null only for an orphan `pending_cleanup` lease whose environment a delete
  // removed. The cleanup sweep tears the orphan down from the row's immutable
  // provider metadata, so it needs no environment row.
  environmentId: string | null;
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
