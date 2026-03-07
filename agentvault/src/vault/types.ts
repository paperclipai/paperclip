/**
 * Types for HashiCorp Vault integration
 *
 * Provides per-agent private Vault instances for secrets and API key management.
 */

/**
 * Vault authentication method
 */
export type VaultAuthMethod = 'token' | 'approle' | 'kubernetes' | 'userpass';

/**
 * Vault secret engine type
 */
export type VaultSecretEngine = 'kv-v2' | 'kv-v1' | 'transit';

/**
 * Vault connection configuration
 */
export interface VaultConfig {
  /** Vault server address (e.g. http://127.0.0.1:8200) */
  address: string;
  /** Authentication method */
  authMethod: VaultAuthMethod;
  /** Vault token (for token auth) */
  token?: string;
  /** AppRole role ID (for approle auth) */
  roleId?: string;
  /** AppRole secret ID (for approle auth) */
  secretId?: string;
  /** Kubernetes auth role (for k8s auth) */
  k8sRole?: string;
  /** Username (for userpass auth) */
  username?: string;
  /** Password (for userpass auth) */
  password?: string;
  /** Vault namespace (enterprise feature) */
  namespace?: string;
  /** TLS CA certificate path */
  caCertPath?: string;
  /** Skip TLS verification (not recommended for production) */
  tlsSkipVerify?: boolean;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Per-agent Vault policy configuration
 */
export interface AgentVaultPolicy {
  /** Agent identifier */
  agentId: string;
  /** Base path in Vault for this agent's secrets */
  secretPath: string;
  /** Secret engine to use */
  engine: VaultSecretEngine;
  /** Whether agent can create new secrets */
  allowCreate: boolean;
  /** Whether agent can update existing secrets */
  allowUpdate: boolean;
  /** Whether agent can delete secrets */
  allowDelete: boolean;
  /** Whether agent can list secrets */
  allowList: boolean;
  /** Maximum number of secrets this agent can store */
  maxSecrets?: number;
  /** Allowed secret key patterns (glob) */
  allowedKeyPatterns?: string[];
}

/**
 * A secret stored in Vault
 */
export interface VaultSecret {
  /** Secret key/path */
  key: string;
  /** Secret value (string or key-value map) */
  value: string | Record<string, string>;
  /** Metadata */
  metadata: VaultSecretMetadata;
}

/**
 * Vault secret metadata
 */
export interface VaultSecretMetadata {
  /** Secret version number */
  version: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
  /** Whether the secret has been destroyed */
  destroyed: boolean;
  /** Custom metadata key-value pairs */
  customMetadata?: Record<string, string>;
}

/**
 * Result of a Vault operation
 */
export interface VaultOperationResult<T = void> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Result data (if applicable) */
  data?: T;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Vault health status
 */
export interface VaultHealthStatus {
  /** Whether Vault is initialized */
  initialized: boolean;
  /** Whether Vault is sealed */
  sealed: boolean;
  /** Vault server version */
  version: string;
  /** Cluster name */
  clusterName?: string;
}

/**
 * Agent Vault initialization options
 */
export interface AgentVaultInitOptions {
  /** Agent identifier */
  agentId: string;
  /** Secret engine type */
  engine?: VaultSecretEngine;
  /** Maximum number of secrets */
  maxSecrets?: number;
  /** Allowed key patterns */
  allowedKeyPatterns?: string[];
}

/**
 * Vault secret list entry (without value)
 */
export interface VaultSecretListEntry {
  /** Secret key/path */
  key: string;
  /** Secret version */
  version: number;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}
