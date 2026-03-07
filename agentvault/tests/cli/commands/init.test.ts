import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initCommand, promptForInitOptions, executeInit } from '../../../cli/commands/init.js';

// Mock inquirer
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
  },
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
  },
}));

describe('init command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initCommand', () => {
    it('should create a Commander command', () => {
      const command = initCommand();
      expect(command).toBeDefined();
      expect(command.name()).toBe('init');
    });

    it('should have correct description', () => {
      const command = initCommand();
      expect(command.description()).toContain('Initialize');
    });

    it('should have --name option', () => {
      const command = initCommand();
      const nameOption = command.options.find((opt) => opt.long === '--name');
      expect(nameOption).toBeDefined();
    });

    it('should have --yes option', () => {
      const command = initCommand();
      const yesOption = command.options.find((opt) => opt.long === '--yes');
      expect(yesOption).toBeDefined();
    });
  });

  describe('promptForInitOptions', () => {
    it('should return defaults when --yes flag is set', async () => {
      const result = await promptForInitOptions({ yes: true });
      expect(result).toEqual({
        name: 'my-agent',
        description: 'An AgentVault agent',
        confirm: true,
      });
    });

    it('should use provided name with --yes flag', async () => {
      const result = await promptForInitOptions({ yes: true, name: 'custom-agent' });
      expect(result).toEqual({
        name: 'custom-agent',
        description: 'An AgentVault agent',
        confirm: true,
      });
    });

    it('should call inquirer.prompt when --yes is not set', async () => {
      const inquirer = await import('inquirer');
      const mockPrompt = vi.mocked(inquirer.default.prompt);
      mockPrompt.mockResolvedValueOnce({
        name: 'test-agent',
        description: 'Test description',
        confirm: true,
      });

      const result = await promptForInitOptions({});

      expect(mockPrompt).toHaveBeenCalled();
      expect(result).toEqual({
        name: 'test-agent',
        description: 'Test description',
        confirm: true,
      });
    });
  });

  describe('executeInit', () => {
    it('should execute without throwing', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const answers = {
        name: 'test-agent',
        description: 'Test description',
      } as any;

      const options = {
        confirm: true,
      } as any;

      const sourcePath = process.cwd();

      await expect(
        executeInit(answers, options, sourcePath)
      ).resolves.not.toThrow();

      consoleSpy.mockRestore();
    });
  });
});
