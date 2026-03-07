/**
 * Vault configuration management
 *
 * Handles loading, saving, and validating Vault connection configs
 * from the AgentVault config directory (~/.agentvault/vault/).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { VaultConfig, AgentVaultPolicy, VaultSecretEngine } from './types.js';

/** Default Vault configuration directory */
const VAULT_CONFIG_DIR = path.join(os.homedir(), '.agentvault', 'vault');

/** Default Vault config file name */
const VAULT_CONFIG_FILE = 'vault.json';

/** Agent policies file name */
const AGENT_POLICIES_FILE = 'agent-policies.json';

/**
 * Get the Vault configuration directory path
 */
export function getVaultConfigDir(): string {
  return VAULT_CONFIG_DIR;
}

/**
 * Ensure the Vault configuration directory exists
 */
export function ensureVaultConfigDir(): void {
  if (!fs.existsSync(VAULT_CONFIG_DIR)) {
    fs.mkdirSync(VAULT_CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load Vault connection configuration from disk
 *
 * Configuration is read from:
 * 1. ~/.agentvault/vault/vault.json (file config)
 * 2. Environment variables (override file config)
 *
 * Environment variables:
 * - VAULT_ADDR: Vault server address
 * - VAULT_TOKEN: Vault token
 * - VAULT_NAMESPACE: Vault namespace
 * - VAULT_CACERT: CA cert path
 * - VAULT_SKIP_VERIFY: Skip TLS verification
 * - VAULT_ROLE_ID: AppRole role ID
 * - VAULT_SECRET_ID: AppRole secret ID
 *
 * @returns Vault configuration or null if not configured
 */
export function loadVaultConfig(): VaultConfig | null {
  let config: Partial<VaultConfig> = {};

  // Try loading from file
  const configPath = path.join(VAULT_CONFIG_DIR, VAULT_CONFIG_FILE);
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content) as Partial<VaultConfig>;
    } catch {
      // Ignore parse errors, fall through to env vars
    }
  }

  // Override with environment variables
  if (process.env.VAULT_ADDR) {
    config.address = process.env.VAULT_ADDR;
  }
  if (process.env.VAULT_TOKEN) {
    config.token = process.env.VAULT_TOKEN;
    config.authMethod = 'token';
  }
  if (process.env.VAULT_NAMESPACE) {
    config.namespace = process.env.VAULT_NAMESPACE;
  }
  if (process.env.VAULT_CACERT) {
    config.caCertPath = process.env.VAULT_CACERT;
  }
  if (process.env.VAULT_SKIP_VERIFY === 'true') {
    config.tlsSkipVerify = true;
  }
  if (process.env.VAULT_ROLE_ID) {
    config.roleId = process.env.VAULT_ROLE_ID;
    config.authMethod = 'approle';
  }
  if (process.env.VAULT_SECRET_ID) {
    config.secretId = process.env.VAULT_SECRET_ID;
  }

  // Validate minimum config
  if (!config.address) {
    return null;
  }

  if (!config.authMethod) {
    config.authMethod = config.token ? 'token' : 'token';
  }

  return config as VaultConfig;
}

/**
 * Save Vault connection configuration to disk
 *
 * @param config - Vault configuration to save
 */
export function saveVaultConfig(config: VaultConfig): void {
  ensureVaultConfigDir();

  // Never persist tokens or passwords to disk
  const safeConfig: Partial<VaultConfig> = {
    address: config.address,
    authMethod: config.authMethod,
    namespace: config.namespace,
    caCertPath: config.caCertPath,
    tlsSkipVerify: config.tlsSkipVerify,
    timeoutMs: config.timeoutMs,
  };

  // Only persist non-sensitive auth config
  if (config.authMethod === 'approle') {
    safeConfig.roleId = config.roleId;
  }
  if (config.authMethod === 'kubernetes') {
    safeConfig.k8sRole = config.k8sRole;
  }
  if (config.authMethod === 'userpass') {
    safeConfig.username = config.username;
  }

  const configPath = path.join(VAULT_CONFIG_DIR, VAULT_CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(safeConfig, null, 2), 'utf-8');
}

/**
 * Load agent Vault policies from disk
 *
 * @returns Map of agent ID to policy
 */
export function loadAgentPolicies(): Map<string, AgentVaultPolicy> {
  const policiesPath = path.join(VAULT_CONFIG_DIR, AGENT_POLICIES_FILE);
  const policies = new Map<string, AgentVaultPolicy>();

  if (!fs.existsSync(policiesPath)) {
    return policies;
  }

  try {
    const content = fs.readFileSync(policiesPath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, AgentVaultPolicy>;

    for (const [agentId, policy] of Object.entries(parsed)) {
      policies.set(agentId, policy);
    }
  } catch {
    // Return empty map on parse errors
  }

  return policies;
}

/**
 * Save agent Vault policies to disk
 *
 * @param policies - Map of agent ID to policy
 */
export function saveAgentPolicies(policies: Map<string, AgentVaultPolicy>): void {
  ensureVaultConfigDir();

  const record: Record<string, AgentVaultPolicy> = {};
  for (const [agentId, policy] of policies.entries()) {
    record[agentId] = policy;
  }

  const policiesPath = path.join(VAULT_CONFIG_DIR, AGENT_POLICIES_FILE);
  fs.writeFileSync(policiesPath, JSON.stringify(record, null, 2), 'utf-8');
}

/**
 * Get or create a policy for an agent
 *
 * @param agentId - Agent identifier
 * @param engine - Secret engine type
 * @returns Agent Vault policy
 */
export function getOrCreateAgentPolicy(
  agentId: string,
  engine: VaultSecretEngine = 'kv-v2',
): AgentVaultPolicy {
  const policies = loadAgentPolicies();

  const existing = policies.get(agentId);
  if (existing) {
    return existing;
  }

  const policy: AgentVaultPolicy = {
    agentId,
    secretPath: `agents/${agentId}/secrets`,
    engine,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: false,
    allowList: true,
  };

  policies.set(agentId, policy);
  saveAgentPolicies(policies);

  return policy;
}

/**
 * Validate a Vault configuration
 *
 * @param config - Configuration to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateVaultConfig(config: VaultConfig): string[] {
  const errors: string[] = [];

  if (!config.address) {
    errors.push('Vault address is required');
  } else {
    try {
      new URL(config.address);
    } catch {
      errors.push(`Invalid Vault address URL: ${config.address}`);
    }
  }

  if (!config.authMethod) {
    errors.push('Authentication method is required');
  }

  switch (config.authMethod) {
    case 'token':
      if (!config.token) {
        errors.push('Vault token is required for token authentication');
      }
      break;
    case 'approle':
      if (!config.roleId) {
        errors.push('Role ID is required for AppRole authentication');
      }
      if (!config.secretId) {
        errors.push('Secret ID is required for AppRole authentication');
      }
      break;
    case 'kubernetes':
      if (!config.k8sRole) {
        errors.push('Kubernetes role is required for Kubernetes authentication');
      }
      break;
    case 'userpass':
      if (!config.username) {
        errors.push('Username is required for userpass authentication');
      }
      if (!config.password) {
        errors.push('Password is required for userpass authentication');
      }
      break;
    default:
      errors.push(`Unknown authentication method: ${config.authMethod}`);
  }

  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    errors.push('Timeout must be a positive number');
  }

  return errors;
}
