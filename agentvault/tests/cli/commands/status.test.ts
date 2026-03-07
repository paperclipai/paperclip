import { describe, it, expect, vi, beforeEach } from 'vitest';
import { statusCommand, getProjectStatus, displayStatus } from '../../../cli/commands/status.js';
import { VERSION } from '../../../src/index.js';

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

describe('status command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('statusCommand', () => {
    it('should create a Commander command', () => {
      const command = statusCommand();
      expect(command).toBeDefined();
      expect(command.name()).toBe('status');
    });

    it('should have correct description', () => {
      const command = statusCommand();
      expect(command.description()).toContain('status');
    });

    it('should have --json option', () => {
      const command = statusCommand();
      const jsonOption = command.options.find((opt) => opt.long === '--json');
      expect(jsonOption).toBeDefined();
    });
  });

  describe('getProjectStatus', () => {
    it('should return project status', async () => {
      const status = await getProjectStatus();

      expect(status).toHaveProperty('initialized');
      expect(status).toHaveProperty('version');
      expect(status).toHaveProperty('agentName');
      expect(status).toHaveProperty('canisterDeployed');
    });

    it('should return correct version', async () => {
      const status = await getProjectStatus();
      expect(status.version).toBe(VERSION);
    });

    it('should return initialized as false for new project', async () => {
      const status = await getProjectStatus();
      expect(status.initialized).toBe(false);
    });
  });

  describe('displayStatus', () => {
    it('should display status without throwing', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(
        displayStatus({
          initialized: false,
          version: VERSION,
          agentName: null,
          canisterDeployed: false,
        })
      ).resolves.not.toThrow();

      consoleSpy.mockRestore();
    });

    it('should display initialized project status', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await displayStatus({
        initialized: true,
        version: VERSION,
        agentName: 'test-agent',
        canisterDeployed: true,
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
