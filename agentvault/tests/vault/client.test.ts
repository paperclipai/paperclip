/**
 * Vault client tests
 */

import { describe, it, expect } from 'vitest';
import { VaultClient } from '../../src/vault/client.js';
import type { VaultConfig, AgentVaultPolicy } from '../../src/vault/types.js';

/**
 * Create a test config and policy for VaultClient tests.
 * These tests verify the client's local behavior (validation, policy
 * enforcement, path building) without making actual Vault API calls.
 */
function createTestClient(
  agentId: string = 'test-agent',
  policyOverrides?: Partial<AgentVaultPolicy>,
): VaultClient {
  const config: VaultConfig = {
    address: 'http://127.0.0.1:8200',
    authMethod: 'token',
    token: 'hvs.test-token',
  };

  const policy: AgentVaultPolicy = {
    agentId,
    secretPath: `agents/${agentId}/secrets`,
    engine: 'kv-v2',
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    allowList: true,
    ...policyOverrides,
  };

  return VaultClient.createWithConfig(config, policy);
}

describe('VaultClient', () => {
  describe('createWithConfig', () => {
    it('should create a client with explicit config', () => {
      const client = createTestClient('my-agent');
      expect(client).toBeInstanceOf(VaultClient);
      expect(client.agentId).toBe('my-agent');
    });

    it('should expose the agent secret path', () => {
      const client = createTestClient('my-agent');
      expect(client.secretPath).toBe('agents/my-agent/secrets');
    });
  });

  describe('create (static)', () => {
    it('should throw when Vault is not configured', () => {
      // Without VAULT_ADDR set and no config file, create() should throw
      const originalAddr = process.env.VAULT_ADDR;
      const originalToken = process.env.VAULT_TOKEN;
      delete process.env.VAULT_ADDR;
      delete process.env.VAULT_TOKEN;

      try {
        expect(() => VaultClient.create('test-agent')).toThrow(/not configured/);
      } finally {
        if (originalAddr) process.env.VAULT_ADDR = originalAddr;
        if (originalToken) process.env.VAULT_TOKEN = originalToken;
      }
    });
  });

  describe('getPolicy', () => {
    it('should return a copy of the policy', () => {
      const client = createTestClient('policy-agent');
      const policy = client.getPolicy();

      expect(policy.agentId).toBe('policy-agent');
      expect(policy.engine).toBe('kv-v2');
      expect(policy.allowCreate).toBe(true);
      expect(policy.allowDelete).toBe(true);
    });

    it('should not expose internal policy reference', () => {
      const client = createTestClient('policy-agent');
      const policy1 = client.getPolicy();
      const policy2 = client.getPolicy();

      // Should be equal but not the same reference
      expect(policy1).toEqual(policy2);
      expect(policy1).not.toBe(policy2);
    });
  });

  describe('key validation', () => {
    it('should reject empty key on getSecret', async () => {
      const client = createTestClient();
      const result = await client.getSecret('');
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject path traversal on getSecret', async () => {
      const client = createTestClient();
      const result = await client.getSecret('../../../etc/passwd');
      expect(result.success).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('should reject keys starting with slash', async () => {
      const client = createTestClient();
      const result = await client.getSecret('/absolute-path');
      expect(result.success).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('should reject empty key on putSecret', async () => {
      const client = createTestClient();
      const result = await client.putSecret('', 'value');
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should reject path traversal on putSecret', async () => {
      const client = createTestClient();
      const result = await client.putSecret('../escape', 'value');
      expect(result.success).toBe(false);
      expect(result.error).toContain('path traversal');
    });

    it('should reject empty key on deleteSecret', async () => {
      const client = createTestClient();
      const result = await client.deleteSecret('');
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });
  });

  describe('policy enforcement', () => {
    it('should reject writes when allowCreate and allowUpdate are false', async () => {
      const client = createTestClient('read-only', {
        allowCreate: false,
        allowUpdate: false,
      });

      const result = await client.putSecret('key', 'value');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed to write');
    });

    it('should reject deletes when allowDelete is false', async () => {
      const client = createTestClient('no-delete', {
        allowDelete: false,
      });

      const result = await client.deleteSecret('key');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed to delete');
    });

    it('should reject listing when allowList is false', async () => {
      const client = createTestClient('no-list', {
        allowList: false,
      });

      const result = await client.listSecrets();
      expect(result.success).toBe(false);
      expect(result.error).toContain('not allowed to list');
    });
  });

  describe('key pattern enforcement', () => {
    it('should reject keys not matching allowed patterns', async () => {
      const client = createTestClient('pattern-agent', {
        allowedKeyPatterns: ['api-*', 'config-*'],
      });

      const result = await client.getSecret('database-password');
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match allowed patterns');
    });

    it('should accept keys matching allowed patterns', async () => {
      const client = createTestClient('pattern-agent', {
        allowedKeyPatterns: ['api-*', 'config-*'],
      });

      // This will fail on the network call, but the key validation should pass
      const result = await client.getSecret('api-openai');
      // The error should be about the network, not about key validation
      if (!result.success) {
        expect(result.error).not.toContain('does not match allowed patterns');
      }
    });
  });

  describe('health check', () => {
    it('should return error for unreachable Vault server', async () => {
      const config: VaultConfig = {
        address: 'http://127.0.0.1:19999',
        authMethod: 'token',
        token: 'test',
        timeoutMs: 1000,
      };

      const policy: AgentVaultPolicy = {
        agentId: 'test',
        secretPath: 'agents/test/secrets',
        engine: 'kv-v2',
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowList: true,
      };

      const client = VaultClient.createWithConfig(config, policy);
      const result = await client.health();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to check Vault health');
    });
  });

  describe('secretExists', () => {
    it('should return false for non-existent secrets (unreachable server)', async () => {
      const config: VaultConfig = {
        address: 'http://127.0.0.1:19999',
        authMethod: 'token',
        token: 'test',
        timeoutMs: 1000,
      };

      const policy: AgentVaultPolicy = {
        agentId: 'test',
        secretPath: 'agents/test/secrets',
        engine: 'kv-v2',
        allowCreate: true,
        allowUpdate: true,
        allowDelete: false,
        allowList: true,
      };

      const client = VaultClient.createWithConfig(config, policy);
      const exists = await client.secretExists('nonexistent');

      expect(exists).toBe(false);
    });
  });
});
