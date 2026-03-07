import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createICPClient,
  generateStubCanisterId,
} from '../../src/deployment/icpClient.js';

describe('icpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateStubCanisterId', () => {
    it('should generate a valid canister ID format', () => {
      const id = generateStubCanisterId();

      expect(id).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}-[a-z2-7]{5}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateStubCanisterId());
      }
      expect(ids.size).toBeGreaterThan(95);
    });
  });

  describe('ICPClient', () => {
    describe('constructor', () => {
      it('should create client with local network', () => {
        const client = createICPClient({ network: 'local' });

        expect(client.network).toBe('local');
        expect(client.getHost()).toBe('http://127.0.0.1:4943');
      });

      it('should create client with ic network', () => {
        const client = createICPClient({ network: 'ic' });

        expect(client.network).toBe('ic');
        expect(client.getHost()).toBe('https://ic0.app');
      });

      it('should use custom host if provided', () => {
        const client = createICPClient({
          network: 'local',
          host: 'http://custom:8000',
        });

        expect(client.getHost()).toBe('http://custom:8000');
      });
    });

    describe('checkConnection', () => {
      it('should handle connection errors gracefully', async () => {
        const client = createICPClient({
          network: 'ic',
          host: 'http://invalid-host:9999',
        });

        const result = await client.checkConnection();

        expect(result.connected).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe('getCanisterStatus', () => {
      it('should return error for non-existent canister', async () => {
        const client = createICPClient({ network: 'local' });

        await expect(
          client.getCanisterStatus('nonexistent-canister-id')
        ).rejects.toThrow();
      });
    });

    describe('deploy', () => {
      it('should handle invalid WASM path', async () => {
        const client = createICPClient({ network: 'local' });

        await expect(
          client.deploy('/nonexistent/file.wasm')
        ).rejects.toThrow();
      });

      it('should handle deployment errors', async () => {
        const client = createICPClient({
          network: 'ic',
        });

        await expect(
          client.deploy('/invalid/path.wasm')
        ).rejects.toThrow();
      });
    });
  });
});
