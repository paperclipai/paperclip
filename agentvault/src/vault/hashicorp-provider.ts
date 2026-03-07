/**
 * HashiCorp Vault implementation of `SecretProvider`
 *
 * Wraps `VaultClient` to satisfy the unified `SecretProvider` interface.
 * All reads return plain string values; no value is written to disk or
 * canister state.
 */

import { VaultClient } from './client.js';
import type { SecretProvider, SecretProviderHealth } from './provider.js';

export class HashiCorpVaultProvider implements SecretProvider {
  readonly name = 'HashiCorp Vault';

  constructor(private readonly client: VaultClient) {}

  /** Create a provider for the given agent using the configured Vault. */
  static forAgent(agentId: string): HashiCorpVaultProvider {
    const client = VaultClient.create(agentId);
    return new HashiCorpVaultProvider(client);
  }

  async getSecret(key: string): Promise<string | null> {
    const result = await this.client.getSecret(key);
    if (!result.success || !result.data) return null;

    const { value } = result.data;
    // VaultClient stores strings as { value: "..." } maps; unwrap here
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && 'value' in value) return (value as Record<string, string>).value ?? null;
    return null;
  }

  async storeSecret(key: string, value: string): Promise<void> {
    const result = await this.client.putSecret(key, value);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to store secret "${key}"`);
    }
  }

  async listSecrets(): Promise<string[]> {
    const result = await this.client.listSecrets();
    if (!result.success || !result.data) return [];
    return result.data.map((e) => e.key);
  }

  async deleteSecret(key: string): Promise<void> {
    const result = await this.client.deleteSecret(key);
    if (!result.success) {
      throw new Error(result.error ?? `Failed to delete secret "${key}"`);
    }
  }

  async healthCheck(): Promise<SecretProviderHealth> {
    const result = await this.client.health();
    if (!result.success || !result.data) {
      return { healthy: false, message: result.error ?? 'Vault unreachable' };
    }
    const { initialized, sealed, version } = result.data;
    if (!initialized) return { healthy: false, message: 'Vault not initialized', version };
    if (sealed) return { healthy: false, message: 'Vault is sealed', version };
    return { healthy: true, message: 'Vault is healthy', version };
  }
}
