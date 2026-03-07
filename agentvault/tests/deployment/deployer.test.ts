import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import {
  deployAgent,
  validateDeployOptions,
  getDeploySummary,
  getCanisterStatus,
} from '../../src/deployment/deployer.js';
import { createICPClient } from '../../src/deployment/icpClient.js';
import { detectToolchain } from '../../src/icp/tool-detector.js';
import * as icpcli from '../../src/icp/icpcli.js';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock crypto module
vi.mock('node:crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn().mockReturnValue('abcd1234567890abcd1234567890abcd1234567890abcd1234'),
  })),
}));

// Mock tool detector
vi.mock('../../src/icp/tool-detector.js', () => ({
  detectToolchain: vi.fn(),
}));

// Mock icpcli
vi.mock('../../src/icp/icpcli.js', () => ({
  deploy: vi.fn(),
}));

// Mock environment
vi.mock('../../src/icp/environment.js', () => ({
  getEnvironment: vi.fn(() => ({
    name: 'local',
    network: { type: 'local' },
    cycles: { initial: '100T' },
  })),
}));

// Mock @dfinity/agent HttpAgent to avoid real network calls
vi.mock('@dfinity/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@dfinity/agent')>();
  class MockHttpAgent {
    fetchRootKey = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    status = vi.fn().mockResolvedValue({});
  }
  return {
    ...original,
    HttpAgent: MockHttpAgent,
  };
});

describe('deployer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateDeployOptions', () => {
    it('should return valid for valid options with local network', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );

      const result = validateDeployOptions({
        wasmPath: '/path/to/agent.wasm',
        network: 'local',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return error for non-existent WASM', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = validateDeployOptions({
        wasmPath: '/nonexistent.wasm',
        network: 'local',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_WASM')).toBe(true);
    });

    it('should return error for invalid network name', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.mocked(fs.readFileSync).mockReturnValue(
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
    );

    const result = validateDeployOptions({
      wasmPath: '/path/to/agent.wasm',
      network: 'invalid-network-name' as 'local',
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK')).toBe(true);
  });

    it('should warn about mainnet deployment', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );

      const result = validateDeployOptions({
        wasmPath: '/path/to/agent.wasm',
        network: 'ic',
      });

      expect(result.warnings.some((w) => w.includes('mainnet'))).toBe(true);
    });

    it('should warn about upgrade operation', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );

      const result = validateDeployOptions({
        wasmPath: '/path/to/agent.wasm',
        network: 'local',
        canisterId: 'existing-canister-id',
      });

      expect(result.warnings.some((w) => w.includes('Upgrading'))).toBe(true);
    });
  });

  describe('getDeploySummary', () => {
    it('should return deployment summary', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, size: 2048 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );

      const summary = getDeploySummary({
        wasmPath: '/path/to/my-agent.wasm',
        network: 'local',
      });

      expect(summary.agentName).toBe('my-agent');
      expect(summary.network).toBe('local');
      expect(summary.isUpgrade).toBe(false);
      expect(summary.wasmSize).toBe(2048);
      expect(summary.wasmHash).toBeDefined();
    });

    it('should indicate upgrade when canister ID provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );

      const summary = getDeploySummary({
        wasmPath: '/path/to/agent.wasm',
        network: 'ic',
        canisterId: 'existing-id',
      });

      expect(summary.isUpgrade).toBe(true);
      expect(summary.canisterId).toBe('existing-id');
    });

    it('should handle non-existent file gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const summary = getDeploySummary({
        wasmPath: '/nonexistent.wasm',
        network: 'local',
      });

      expect(summary.wasmHash).toBe('');
      expect(summary.wasmSize).toBe(0);
      expect(summary.validation.valid).toBe(false);
    });
  });

  describe('deployAgent', () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true, size: 1024 } as fs.Stats);
      vi.mocked(fs.readFileSync).mockReturnValue(
        Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
      );
      // Mock toolchain to prefer SDK for these tests
      vi.mocked(detectToolchain).mockResolvedValue({
        icWasm: { name: 'ic-wasm', available: false, path: '', version: '' },
        icp: { name: 'icp', available: false, path: '', version: '' },
        dfx: { name: 'dfx', available: false, path: '', version: '' },
        preferredDeployTool: 'dfx',
        canOptimize: false,
      });
      // Mock icpcli.deploy to succeed
      vi.mocked(icpcli.deploy).mockResolvedValue({
        success: true,
        stdout: 'Deployed canister: rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai',
        stderr: '',
        exitCode: 0,
      });
    });

    it('should throw when validation fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      await expect(
        deployAgent({
          wasmPath: '/nonexistent.wasm',
          network: 'local',
        })
      ).rejects.toThrow('Deployment validation failed');
    });

    it('should deploy new canister successfully', async () => {
      const result = await deployAgent({
        wasmPath: '/path/to/my-agent.wasm',
        network: 'local',
      });

      expect(result.canister).toBeDefined();
      expect(result.canister.canisterId).toBeDefined();
      expect(result.canister.network).toBe('local');
      expect(result.canister.agentName).toBe('my-agent');
      expect(result.isUpgrade).toBe(false);
    });

    it('should upgrade existing canister', async () => {
      const result = await deployAgent({
        wasmPath: '/path/to/agent.wasm',
        network: 'local',
        canisterId: 'existing-canister-id',
      });

      expect(result.canister.canisterId).toBe('existing-canister-id');
      expect(result.isUpgrade).toBe(true);
    });

    it('should include cycles used in result', async () => {
      const result = await deployAgent({
        wasmPath: '/path/to/agent.wasm',
        network: 'local',
      });

      expect(result.cyclesUsed).toBeDefined();
      expect(result.cyclesUsed).toBeGreaterThan(BigInt(0));
    });

    it('should include warnings in result', async () => {
      const result = await deployAgent({
        wasmPath: '/path/to/agent.wasm',
        network: 'ic',
        skipConfirmation: false,
      });

      expect(result.warnings).toBeDefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should set deployed timestamp', async () => {
      const before = new Date();

      const result = await deployAgent({
        wasmPath: '/path/to/agent.wasm',
        network: 'local',
      });

      const after = new Date();
      expect(result.canister.deployedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.canister.deployedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

   describe('getCanisterStatus', () => {
    it('should return canister status when exists', async () => {
      const status = await getCanisterStatus('rrkah-fqaaa-aaaaa-aaaaa-aaaaa-cai', 'local');

      expect(status.exists).toBe(true);
      expect(status.status).toBe('running');
      expect(status.memorySize).toBeDefined();
      expect(status.cycles).toBeDefined();
    });

    it('should return error for non-existent canister', async () => {
      const client = createICPClient({ network: 'local' });

      await expect(
        client.getCanisterStatus('nonexistent-canister-id')
      ).rejects.toThrow();
    });
  });
});
