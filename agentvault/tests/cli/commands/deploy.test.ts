import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deployCommand, displayPreview, displayResult, executeDeploy } from '../../../cli/commands/deploy.js';
import type { DeployResult } from '../../../src/deployment/types.js';

// Mock the deployment module
vi.mock('../../../src/deployment/index.js', () => ({
  deployAgent: vi.fn(),
  getDeploySummary: vi.fn(),
}));

// Mock ora
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// Mock chalk (passthrough for testing)
vi.mock('chalk', () => ({
  default: {
    bold: (str: string) => str,
    green: (str: string) => str,
    yellow: (str: string) => str,
    cyan: (str: string) => str,
    red: (str: string) => str,
  },
}));

// Mock inquirer
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
}));

describe('deploy command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('deployCommand', () => {
    it('should create a Commander command', () => {
      const command = deployCommand();
      expect(command).toBeDefined();
      expect(command.name()).toBe('deploy');
    });

    it('should have correct description', () => {
      const command = deployCommand();
      expect(command.description()).toContain('Deploy');
      expect(command.description()).toContain('ICP');
    });

    it('should have --network option', () => {
      const command = deployCommand();
      const networkOption = command.options.find((opt) => opt.long === '--network');
      expect(networkOption).toBeDefined();
    });

    it('should have --canister-id option', () => {
      const command = deployCommand();
      const canisterOption = command.options.find((opt) => opt.long === '--canister-id');
      expect(canisterOption).toBeDefined();
    });

    it('should have --yes option', () => {
      const command = deployCommand();
      const yesOption = command.options.find((opt) => opt.long === '--yes');
      expect(yesOption).toBeDefined();
    });

    it('should have --dry-run option', () => {
      const command = deployCommand();
      const dryRunOption = command.options.find((opt) => opt.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });

    it('should require wasm argument', () => {
      const command = deployCommand();
      const args = command.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0]?.name()).toBe('wasm');
      expect(args[0]?.required).toBe(true);
    });
  });

  describe('displayPreview', () => {
    it('should display deployment summary', async () => {
      const { getDeploySummary } = await import('../../../src/deployment/index.js');
      vi.mocked(getDeploySummary).mockReturnValue({
        agentName: 'test-agent',
        wasmPath: '/path/to/test-agent.wasm',
        wasmHash: 'abcd1234',
        wasmSize: 2048,
        network: 'local',
        isUpgrade: false,
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displayPreview('/path/to/test-agent.wasm', { network: 'local' });

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('test-agent');
      expect(output).toContain('local');
      expect(output).toContain('New Deploy');

      consoleSpy.mockRestore();
    });

    it('should display upgrade status', async () => {
      const { getDeploySummary } = await import('../../../src/deployment/index.js');
      vi.mocked(getDeploySummary).mockReturnValue({
        agentName: 'test-agent',
        wasmPath: '/path/to/test-agent.wasm',
        wasmHash: 'abcd1234',
        wasmSize: 1024,
        network: 'ic',
        isUpgrade: true,
        canisterId: 'existing-canister-id',
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displayPreview('/path/to/test-agent.wasm', {
        network: 'ic',
        canisterId: 'existing-canister-id',
      });

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Upgrade');
      expect(output).toContain('existing-canister-id');

      consoleSpy.mockRestore();
    });

    it('should display warnings', async () => {
      const { getDeploySummary } = await import('../../../src/deployment/index.js');
      vi.mocked(getDeploySummary).mockReturnValue({
        agentName: 'test-agent',
        wasmPath: '/path/to/test-agent.wasm',
        wasmHash: 'abcd1234',
        wasmSize: 1024,
        network: 'ic',
        isUpgrade: false,
        validation: {
          valid: true,
          errors: [],
          warnings: ['Deploying to IC mainnet will consume cycles'],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displayPreview('/path/to/test-agent.wasm', { network: 'ic' });

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Warning');
      expect(output).toContain('cycles');

      consoleSpy.mockRestore();
    });
  });

  describe('displayResult', () => {
    it('should display deployment result', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result: DeployResult = {
        canister: {
          canisterId: 'abc12-def34-ghi56-jkl78-mno90',
          network: 'local',
          agentName: 'test-agent',
          deployedAt: new Date('2024-01-01'),
          wasmHash: 'abcd1234567890',
        },
        isUpgrade: false,
        cyclesUsed: BigInt(100_000_000_000),
        warnings: [],
      };

      displayResult(result);

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('successfully');
      expect(output).toContain('abc12-def34-ghi56-jkl78-mno90');
      expect(output).toContain('local');
      expect(output).toContain('test-agent');

      consoleSpy.mockRestore();
    });

    it('should display cycles used', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result: DeployResult = {
        canister: {
          canisterId: 'test-canister',
          network: 'ic',
          agentName: 'agent',
          deployedAt: new Date(),
        },
        isUpgrade: false,
        cyclesUsed: BigInt(1_500_000_000_000),
        warnings: [],
      };

      displayResult(result);

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Cycles');
      expect(output).toContain('T'); // Trillion cycles

      consoleSpy.mockRestore();
    });

    it('should display warnings in result', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result: DeployResult = {
        canister: {
          canisterId: 'test-canister',
          network: 'ic',
          agentName: 'agent',
          deployedAt: new Date(),
        },
        isUpgrade: false,
        cyclesUsed: BigInt(100_000_000),
        warnings: ['Low cycle balance'],
      };

      displayResult(result);

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Warning');
      expect(output).toContain('cycle balance');

      consoleSpy.mockRestore();
    });
  });

  describe('executeDeploy', () => {
    it('should handle dry-run mode', async () => {
      const { getDeploySummary } = await import('../../../src/deployment/index.js');
      vi.mocked(getDeploySummary).mockReturnValue({
        agentName: 'test-agent',
        wasmPath: '/path/to/test-agent.wasm',
        wasmHash: 'abcd1234',
        wasmSize: 1024,
        network: 'local',
        isUpgrade: false,
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeDeploy('/path/to/test-agent.wasm', { dryRun: true });

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should execute deployment with --yes flag', async () => {
      const { deployAgent } = await import('../../../src/deployment/index.js');
      const mockResult: DeployResult = {
        canister: {
          canisterId: 'new-canister-id',
          network: 'local',
          agentName: 'test-agent',
          deployedAt: new Date(),
          wasmHash: 'abcd1234',
        },
        isUpgrade: false,
        cyclesUsed: BigInt(100_000_000_000),
        warnings: [],
      };
      vi.mocked(deployAgent).mockResolvedValue(mockResult);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeDeploy('/path/to/test-agent.wasm', { yes: true });

      expect(result).toEqual(mockResult);
      expect(deployAgent).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should throw on deployment failure', async () => {
      const { deployAgent } = await import('../../../src/deployment/index.js');
      vi.mocked(deployAgent).mockRejectedValue(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(executeDeploy('/path/to/agent.wasm', { yes: true })).rejects.toThrow(
        'Network error'
      );

      consoleSpy.mockRestore();
    });

    it('should cancel deployment when user declines', async () => {
      const inquirer = await import('inquirer');
      vi.mocked(inquirer.default.prompt).mockResolvedValue({ confirmed: false });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executeDeploy('/path/to/agent.wasm', {});

      expect(result).toBeNull();
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('cancelled');

      consoleSpy.mockRestore();
    });

    it('should pass options to deployAgent', async () => {
      const { deployAgent } = await import('../../../src/deployment/index.js');
      vi.mocked(deployAgent).mockResolvedValue({
        canister: {
          canisterId: 'test-id',
          network: 'ic',
          agentName: 'agent',
          deployedAt: new Date(),
        },
        isUpgrade: true,
        cyclesUsed: BigInt(100),
        warnings: [],
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await executeDeploy('/path/to/agent.wasm', {
        network: 'ic',
        canisterId: 'existing-canister',
        yes: true,
      });

      expect(deployAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          wasmPath: expect.stringContaining('agent.wasm'),
          network: 'ic',
          canisterId: 'existing-canister',
          skipConfirmation: true,
        })
      );

      consoleSpy.mockRestore();
    });
  });
});
