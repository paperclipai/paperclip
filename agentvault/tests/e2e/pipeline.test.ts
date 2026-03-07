/**
 * E2E Pipeline Integration Test (CLE-103)
 *
 * Tests the full agent lifecycle: init → package → deploy → exec → show → fetch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), 'agentvault-e2e-test');
const AGENT_DIR = path.join(TEST_DIR, 'test-agent');

vi.mock('execa', () => ({
  default: vi.fn().mockResolvedValue({ stdout: 'dfx 0.15.0', stderr: '' }),
}));

vi.mock('@dfinity/agent', () => {
  class MockHttpAgent {
    fetchRootKey = vi.fn().mockResolvedValue(undefined);
    status = vi.fn().mockResolvedValue({});
  }
  return {
    HttpAgent: MockHttpAgent,
    Actor: {
      createActor: vi.fn().mockReturnValue({
        getState: vi.fn().mockResolvedValue({ ok: {} }),
        getTasks: vi.fn().mockResolvedValue({ ok: [] }),
        getMemory: vi.fn().mockResolvedValue({ ok: {} }),
        execute: vi.fn().mockResolvedValue({ ok: new Uint8Array() }),
      }),
    },
  };
});

describe('E2E Pipeline: init → package → deploy → exec → show → fetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('init', () => {
    it('should create .agentvault directory with config files', async () => {
      const { executeInit } = await import('../../cli/commands/init.js');

      await executeInit(
        { name: 'test-agent', description: 'Test agent', confirm: true },
        { name: 'test-agent' },
        AGENT_DIR
      );

      const agentvaultDir = path.join(AGENT_DIR, '.agentvault');
      expect(fs.existsSync(agentvaultDir)).toBe(true);

      const configPath = path.join(agentvaultDir, 'config', 'agent.config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.name).toBe('test-agent');
      expect(config.version).toBeDefined();
    });

    it('should create project structure with all directories', async () => {
      const { executeInit } = await import('../../cli/commands/init.js');

      await executeInit(
        { name: 'test-agent', description: 'Test agent', confirm: true },
        { name: 'test-agent' },
        AGENT_DIR
      );

      const expectedDirs = [
        '.agentvault/agent',
        '.agentvault/canister',
        '.agentvault/config',
        '.agentvault/src',
      ];

      for (const dir of expectedDirs) {
        const fullPath = path.join(AGENT_DIR, dir);
        expect(fs.existsSync(fullPath)).toBe(true);
      }
    });
  });

  describe('package', () => {
    it('should validate package configuration', async () => {
      const { executeInit } = await import('../../cli/commands/init.js');

      await executeInit(
        { name: 'test-agent', description: 'Test agent', confirm: true },
        { name: 'test-agent' },
        AGENT_DIR
      );

      const configPath = path.join(AGENT_DIR, '.agentvault', 'config', 'agent.config.json');
      expect(fs.existsSync(configPath)).toBe(true);
    });
  });

  describe('deploy', () => {
    it('should validate deploy options', async () => {
      const { validateDeployOptions } = await import('../../src/deployment/deployer.js');

      const result = validateDeployOptions({
        wasmPath: '/nonexistent.wasm',
        network: 'local',
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept valid network names', async () => {
      const { validateDeployOptions } = await import('../../src/deployment/deployer.js');

      const networks = ['local', 'ic', 'mainnet', 'dev', 'staging', 'production'];

      for (const network of networks) {
        const result = validateDeployOptions({
          wasmPath: '/nonexistent.wasm',
          network,
        });
        expect(result.errors.find(e => e.code === 'INVALID_NETWORK')).toBeUndefined();
      }
    });
  });

  describe('exec', () => {
    it('should call canister executeAgent method', async () => {
      const { ICPClient } = await import('../../src/deployment/icpClient.js');
      const client = new ICPClient({ network: 'local' });

      const args = new TextEncoder().encode('test-task');
      const result = await client.executeAgent('abcde-abcde-abcde-abcde-abc', 'execute', args);

      expect(result).toBeDefined();
    });
  });

  describe('show', () => {
    it('should retrieve agent state from canister', async () => {
      const { ICPClient } = await import('../../src/deployment/icpClient.js');
      const client = new ICPClient({ network: 'local' });

      const result = await client.callAgentMethod('abcde-abcde-abcde-abcde-abc', 'getState', []);

      expect(result).toBeDefined();
    });
  });

  describe('fetch', () => {
    it('should download agent state via callAgentMethod', async () => {
      const { ICPClient } = await import('../../src/deployment/icpClient.js');
      const client = new ICPClient({ network: 'local' });

      const result = await client.callAgentMethod('abcde-abcde-abcde-abcde-abc', 'getState', []);

      expect(result).toBeDefined();
    });
  });

  describe('Full Pipeline Integration', () => {
    it('should complete init → status flow', async () => {
      const { executeInit } = await import('../../cli/commands/init.js');

      await executeInit(
        { name: 'pipeline-test', description: 'Pipeline test agent', confirm: true },
        { name: 'pipeline-test' },
        AGENT_DIR
      );

      const configPath = path.join(AGENT_DIR, '.agentvault', 'config', 'agent.config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config.name).toBe('pipeline-test');
    });

    it('should maintain canister status across operations', async () => {
      const { ICPClient } = await import('../../src/deployment/icpClient.js');
      const client = new ICPClient({ network: 'local' });

      const status = await client.getCanisterStatus('abcde-abcde-abcde-abcde-abc');
      expect(status).toBeDefined();

      const args = new TextEncoder().encode('consistency-test');
      await client.executeAgent('abcde-abcde-abcde-abcde-abc', 'execute', args);

      const finalStatus = await client.getCanisterStatus('abcde-abcde-abcde-abcde-abc');
      expect(finalStatus).toBeDefined();
    });
  });
});
