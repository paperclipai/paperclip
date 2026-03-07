/**
 * Types for the AgentVault Private ICP Replica (Pilot) module
 *
 * Supports PRD-004: Internal Pilot – Private ICP Replica for Company Guild
 */

// ─── Replica Types ────────────────────────────────────────────────────────────

/** Replica backend type */
export type ReplicaType = 'local' | 'kubernetes' | 'docker';

/** Deployment target for the full stack */
export type StackTarget = 'cli' | 'canisters' | 'webapp' | 'macos' | 'full';

/** Air-gap mode configuration */
export interface AirGapConfig {
  /** Whether air-gap mode is enabled */
  enabled: boolean;
  /** Allowed inference endpoints (bypassed from air-gap) */
  allowedEndpoints: string[];
  /** Whether to block Arweave */
  blockArweave: boolean;
  /** Whether to block Bittensor */
  blockBittensor: boolean;
}

/** Proxy configuration for external services */
export interface ProxyConfig {
  /** Anthropic API proxy endpoint (empty = use official) */
  anthropicProxy?: string;
  /** Arweave gateway proxy (empty = disabled in air-gap) */
  arweaveProxy?: string;
  /** Bittensor endpoint proxy (empty = disabled in air-gap) */
  bittensorProxy?: string;
  /**
   * VPS proxy endpoint through which all Binance API calls are routed.
   * The VPS must sit behind a firewall that enforces the IP whitelist and
   * rate-limits outbound connections to api.binance.com.
   * Example: "https://trade-proxy.internal:8443"
   */
  binanceProxy?: string;
  /** Custom environment variables to inject */
  extraEnv?: Record<string, string>;
}

/** Private replica network configuration */
export interface PrivateReplicaConfig {
  /** Company/org identifier */
  company: string;
  /** Replica backend */
  replicaType: ReplicaType;
  /** Local port for replica API */
  port: number;
  /** Replica bind address */
  bindAddress: string;
  /** Whether to enable mDNS announcement */
  mdnsEnabled: boolean;
  /** mDNS service name */
  mdnsServiceName: string;
  /** Initial cycles for canisters */
  initialCycles: string;
  /** Air-gap configuration */
  airGap: AirGapConfig;
  /** Proxy configuration for external calls */
  proxy: ProxyConfig;
  /** Path to dfx identity PEM file */
  identityPath?: string;
  /** Canister IDs after deployment (populated post-init) */
  canisterIds?: Record<string, string>;
  /** Replica state directory */
  stateDir: string;
  /** Config file path */
  configPath: string;
  /** When this config was created */
  createdAt: string;
  /** Last known status */
  status: 'stopped' | 'running' | 'error';
}

/** Result from pilot init */
export interface PilotInitResult {
  /** Whether init succeeded */
  success: boolean;
  /** Config written to disk */
  config: PrivateReplicaConfig;
  /** Replica URL */
  replicaUrl: string;
  /** Canister IDs deployed */
  canisterIds: Record<string, string>;
  /** Steps completed */
  steps: PilotStep[];
  /** Warnings */
  warnings: string[];
}

/** Result from full-stack deploy */
export interface PilotDeployResult {
  /** Whether deploy succeeded */
  success: boolean;
  /** Replica URL */
  replicaUrl: string;
  /** Deployed canister IDs */
  canisterIds: Record<string, string>;
  /** Steps completed */
  steps: PilotStep[];
  /** Warnings */
  warnings: string[];
}

/** Status of a pilot replica */
export interface PilotStatus {
  /** Whether the replica is running */
  running: boolean;
  /** Company identifier */
  company: string;
  /** Replica URL */
  replicaUrl: string;
  /** Replica type */
  replicaType: ReplicaType;
  /** Air-gap enabled */
  airGapEnabled: boolean;
  /** Deployed canister IDs */
  canisterIds: Record<string, string>;
  /** Detected via mDNS */
  mdnsDetected?: boolean;
}

/** A single step in the pilot workflow */
export interface PilotStep {
  /** Step name */
  name: string;
  /** Whether the step succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
  /** Output from step */
  output?: string;
}

/** Options for pilot init command */
export interface PilotInitOptions {
  company: string;
  replica: ReplicaType;
  port?: number;
  cycles?: string;
  identity?: string;
  yes?: boolean;
  airGap?: boolean;
  anthropicProxy?: string;
  arweaveProxy?: string;
  bittensorProxy?: string;
  mdns?: boolean;
}

/** Options for pilot deploy command */
export interface PilotDeployOptions {
  stack: StackTarget;
  yes?: boolean;
  dryRun?: boolean;
}

/** mDNS service record for private replica discovery */
export interface MdnsReplicaRecord {
  /** Service hostname */
  hostname: string;
  /** Port */
  port: number;
  /** Company identifier */
  company: string;
  /** Replica URL */
  replicaUrl: string;
}

// ─── Config file schema ────────────────────────────────────────────────────

/** The on-disk structure of a .agentvault/pilot.json config */
export interface PilotConfigFile {
  version: '1';
  company: string;
  replicaType: ReplicaType;
  port: number;
  bindAddress: string;
  mdns: {
    enabled: boolean;
    serviceName: string;
  };
  initialCycles: string;
  airGap: AirGapConfig;
  proxy: ProxyConfig;
  identityPath?: string;
  canisterIds: Record<string, string>;
  stateDir: string;
  createdAt: string;
  status: 'stopped' | 'running' | 'error';
}
