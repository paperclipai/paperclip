import { describe, it, expect, vi, beforeEach } from 'vitest';
import { packageCommand, displayPreview, displayResult, executePackage } from '../../../cli/commands/package.js';
import type { PackageResult } from '../../../src/packaging/types.js';

// Mock the packaging module
vi.mock('../../../src/packaging/index.js', () => ({
  packageAgent: vi.fn(),
  getPackageSummary: vi.fn(),
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

describe('package command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('packageCommand', () => {
    it('should create a Commander command', () => {
      const command = packageCommand();
      expect(command).toBeDefined();
      expect(command.name()).toBe('package');
    });

    it('should have correct description', () => {
      const command = packageCommand();
      expect(command.description()).toContain('Compile');
      expect(command.description()).toContain('WASM');
    });

    it('should have --output option', () => {
      const command = packageCommand();
      const outputOption = command.options.find((opt) => opt.long === '--output');
      expect(outputOption).toBeDefined();
    });

    it('should have --force option', () => {
      const command = packageCommand();
      const forceOption = command.options.find((opt) => opt.long === '--force');
      expect(forceOption).toBeDefined();
    });

    it('should have --skip-validation option', () => {
      const command = packageCommand();
      const skipOption = command.options.find((opt) => opt.long === '--skip-validation');
      expect(skipOption).toBeDefined();
    });

    it('should have --dry-run option', () => {
      const command = packageCommand();
      const dryRunOption = command.options.find((opt) => opt.long === '--dry-run');
      expect(dryRunOption).toBeDefined();
    });

    it('should accept source argument with default value', () => {
      const command = packageCommand();
      const args = command.registeredArguments;
      expect(args.length).toBe(1);
      expect(args[0]?.name()).toBe('source');
      expect(args[0]?.defaultValue).toBe('.');
    });
  });

  describe('displayPreview', () => {
    it('should display agent configuration', async () => {
      const { getPackageSummary } = await import('../../../src/packaging/index.js');
      vi.mocked(getPackageSummary).mockReturnValue({
        config: {
          name: 'test-agent',
          type: 'clawdbot',
          sourcePath: '/path/to/agent',
          entryPoint: 'index.ts',
          version: '1.0.0',
        },
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displayPreview('/path/to/agent');

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('test-agent');
      expect(output).toContain('clawdbot');

      consoleSpy.mockRestore();
    });

    it('should display warnings', async () => {
      const { getPackageSummary } = await import('../../../src/packaging/index.js');
      vi.mocked(getPackageSummary).mockReturnValue({
        config: {
          name: 'test-agent',
          type: 'generic',
          sourcePath: '/path/to/agent',
        },
        validation: {
          valid: true,
          errors: [],
          warnings: ['No entry point detected'],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      displayPreview('/path/to/agent');

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Warning');
      expect(output).toContain('entry point');

      consoleSpy.mockRestore();
    });
  });

  describe('displayResult', () => {
    it('should display package result', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result: PackageResult = {
        config: {
          name: 'test-agent',
          type: 'clawdbot',
          sourcePath: '/path/to/agent',
        },
        wasmPath: '/output/test-agent.wasm',
        watPath: '/output/test-agent.wat',
        statePath: '/output/test-agent.state.json',
        wasmSize: 1024,
        timestamp: new Date(),
        target: 'wasmedge',
      };

      displayResult(result);

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('successfully');
      expect(output).toContain('.wasm');
      expect(output).toContain('.wat');
      expect(output).toContain('.state.json');

      consoleSpy.mockRestore();
    });

    it('should format file size correctly', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result: PackageResult = {
        config: {
          name: 'test-agent',
          type: 'clawdbot',
          sourcePath: '/path/to/agent',
        },
        wasmPath: '/output/test-agent.wasm',
        watPath: '/output/test-agent.wat',
        statePath: '/output/test-agent.state.json',
        wasmSize: 2048, // 2 KB
        timestamp: new Date(),
        target: 'wasmedge',
      };

      displayResult(result);

      const output = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('KB');

      consoleSpy.mockRestore();
    });
  });

  describe('executePackage', () => {
    it('should handle dry-run mode', async () => {
      const { getPackageSummary } = await import('../../../src/packaging/index.js');
      vi.mocked(getPackageSummary).mockReturnValue({
        config: {
          name: 'test-agent',
          type: 'clawdbot',
          sourcePath: '/path/to/agent',
        },
        validation: {
          valid: true,
          errors: [],
          warnings: [],
        },
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executePackage('/path/to/agent', { dryRun: true });

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should execute packaging successfully', async () => {
      const { packageAgent } = await import('../../../src/packaging/index.js');
      const mockResult: PackageResult = {
        config: {
          name: 'test-agent',
          type: 'clawdbot',
          sourcePath: '/path/to/agent',
        },
        wasmPath: '/output/test-agent.wasm',
        watPath: '/output/test-agent.wat',
        statePath: '/output/test-agent.state.json',
        wasmSize: 1024,
        timestamp: new Date(),
        target: 'wasmedge',
      };
      vi.mocked(packageAgent).mockResolvedValue(mockResult);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await executePackage('/path/to/agent', {});

      expect(result).toEqual(mockResult);
      expect(packageAgent).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should throw on packaging failure', async () => {
      const { packageAgent } = await import('../../../src/packaging/index.js');
      vi.mocked(packageAgent).mockRejectedValue(new Error('Compilation failed'));

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(executePackage('/path/to/agent', {})).rejects.toThrow('Compilation failed');

      consoleSpy.mockRestore();
    });

    it('should pass options to packageAgent', async () => {
      const { packageAgent } = await import('../../../src/packaging/index.js');
      vi.mocked(packageAgent).mockResolvedValue({
        config: { name: 'test', type: 'generic', sourcePath: '/path' },
        wasmPath: '/out/test.wasm',
        watPath: '/out/test.wat',
        statePath: '/out/test.state.json',
        wasmSize: 100,
        timestamp: new Date(),
        target: 'wasmedge',
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await executePackage('/path/to/agent', {
        output: '/custom/output',
        force: true,
        skipValidation: true,
      });

      expect(packageAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: '/path/to/agent',
          outputPath: expect.stringContaining('custom'),
          force: true,
          skipValidation: true,
        })
      );

      consoleSpy.mockRestore();
    });
  });
});
