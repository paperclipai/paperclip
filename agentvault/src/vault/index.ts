/**
 * Secret management for AgentVault
 *
 * Supports HashiCorp Vault (self-hosted via Docker or any Vault server) and
 * Bitwarden CLI as secret backends.  All providers implement the `SecretProvider`
 * interface – secrets are fetched at runtime only and are NEVER persisted to
 * the ICP canister.
 *
 * Quick start (HashiCorp Vault):
 *   # Start local Vault:  docker compose up -d
 *   import { HashiCorpVaultProvider } from './vault/index.js';
 *   const provider = HashiCorpVaultProvider.forAgent('my-agent');
 *   await provider.storeSecret('api_binance', process.env.KEY!);
 *   const key = await provider.getSecret('api_binance'); // fetch at runtime only
 *
 * Quick start (Bitwarden):
 *   import { BitwardenProvider } from './vault/index.js';
 *   const provider = new BitwardenProvider({ agentId: 'my-agent' });
 *   const key = await provider.getSecret('api_binance');
 */

export * from './types.js';
export { VaultClient } from './client.js';
export {
  loadVaultConfig,
  saveVaultConfig,
  loadAgentPolicies,
  saveAgentPolicies,
  getOrCreateAgentPolicy,
  validateVaultConfig,
  getVaultConfigDir,
  ensureVaultConfigDir,
} from './config.js';

// Unified provider interface + runtime helpers
export type { SecretProvider, SecretProviderHealth } from './provider.js';
export { fetchSecretsAsEnv, fetchAllSecretsAsEnv } from './provider.js';

// Concrete provider implementations
export { HashiCorpVaultProvider } from './hashicorp-provider.js';
export { BitwardenProvider } from './bitwarden.js';
export type { BitwardenConfig } from './bitwarden.js';
