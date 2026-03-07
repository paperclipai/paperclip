/**
 * Tests for the unified SecretProvider interface and runtime helpers.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fetchSecretsAsEnv,
  fetchAllSecretsAsEnv,
  type SecretProvider,
} from '../../src/vault/provider.js';

// ---------------------------------------------------------------------------
// Test double – an in-memory provider that satisfies SecretProvider
// ---------------------------------------------------------------------------

function makeMemoryProvider(initial: Record<string, string> = {}): SecretProvider {
  const store = new Map(Object.entries(initial));

  return {
    name: 'MemoryProvider',

    async getSecret(key: string) {
      return store.get(key) ?? null;
    },

    async storeSecret(key: string, value: string) {
      store.set(key, value);
    },

    async listSecrets() {
      return Array.from(store.keys());
    },

    async deleteSecret(key: string) {
      if (!store.has(key)) throw new Error(`Key "${key}" not found`);
      store.delete(key);
    },

    async healthCheck() {
      return { healthy: true, message: 'memory provider is always healthy' };
    },
  };
}

// ---------------------------------------------------------------------------

describe('fetchSecretsAsEnv', () => {
  it('returns an empty object when no keys are requested', async () => {
    const provider = makeMemoryProvider({ api_key: 'secret' });
    const env = await fetchSecretsAsEnv(provider, []);
    expect(env).toEqual({});
  });

  it('converts snake_case keys to UPPER_SNAKE_CASE env-var names', async () => {
    const provider = makeMemoryProvider({
      api_binance: 'binance-secret-123',
      openai_key: 'sk-test',
    });

    const env = await fetchSecretsAsEnv(provider, ['api_binance', 'openai_key']);
    expect(env).toEqual({
      API_BINANCE: 'binance-secret-123',
      OPENAI_KEY: 'sk-test',
    });
  });

  it('converts hyphenated keys to underscored env-var names', async () => {
    const provider = makeMemoryProvider({ 'my-api-key': 'value' });
    const env = await fetchSecretsAsEnv(provider, ['my-api-key']);
    expect(env).toEqual({ MY_API_KEY: 'value' });
  });

  it('silently skips keys that do not exist in the backend', async () => {
    const provider = makeMemoryProvider({ existing: 'yes' });
    const env = await fetchSecretsAsEnv(provider, ['existing', 'missing']);
    expect(env).toEqual({ EXISTING: 'yes' });
    expect('MISSING' in env).toBe(false);
  });

  it('fetches multiple secrets concurrently', async () => {
    const getSpy = vi.fn(async (key: string) => key === 'a' ? 'alpha' : key === 'b' ? 'beta' : null);
    const provider: SecretProvider = {
      ...makeMemoryProvider(),
      getSecret: getSpy,
    };

    const env = await fetchSecretsAsEnv(provider, ['a', 'b', 'c']);
    expect(getSpy).toHaveBeenCalledTimes(3);
    expect(env).toEqual({ A: 'alpha', B: 'beta' });
  });
});

describe('fetchAllSecretsAsEnv', () => {
  it('fetches all secrets from the provider', async () => {
    const provider = makeMemoryProvider({
      api_binance: 'bfx-123',
      db_password: 's3cr3t',
    });

    const env = await fetchAllSecretsAsEnv(provider);
    expect(env).toEqual({
      API_BINANCE: 'bfx-123',
      DB_PASSWORD: 's3cr3t',
    });
  });

  it('returns empty object for an empty provider', async () => {
    const provider = makeMemoryProvider();
    const env = await fetchAllSecretsAsEnv(provider);
    expect(env).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Zero-persistence contract: verify values are NOT attached to anything durable
// ---------------------------------------------------------------------------

describe('zero-persistence contract', () => {
  it('fetchSecretsAsEnv result is a plain object with no prototype methods leaking secrets', async () => {
    const provider = makeMemoryProvider({ my_key: 'supersecret' });
    const env = await fetchSecretsAsEnv(provider, ['my_key']);

    // Must be a plain object (no class instance that could accidentally persist)
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    // Value is present but only in-memory as a regular property
    expect(env.MY_KEY).toBe('supersecret');
  });

  it('the provider memory store is independent of the returned env object', async () => {
    const provider = makeMemoryProvider({ shared_key: 'abc' });
    const env = await fetchSecretsAsEnv(provider, ['shared_key']);

    // Mutating the returned env does not affect the backend
    env.SHARED_KEY = 'tampered';
    const fresh = await provider.getSecret('shared_key');
    expect(fresh).toBe('abc');
  });
});
