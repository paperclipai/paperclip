import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloudBackupCmd } from '../../cli/commands/cloud-backup.js';

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
    gray: (str: string) => str,
    red: (str: string) => str,
  },
}));

describe('cloud-backup CLI command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('command structure', () => {
    it('should define the cloud-backup command', () => {
      expect(cloudBackupCmd).toBeDefined();
      expect(cloudBackupCmd.name()).toBe('cloud-backup');
    });

    it('should have a description', () => {
      const desc = cloudBackupCmd.description();
      expect(desc).toContain('Archive and restore');
      expect(desc).toContain('cloud storage');
    });

    it('should have providers subcommand', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'providers',
      );
      expect(sub).toBeDefined();
      expect(sub!.description()).toContain('Detect');
    });

    it('should have archive subcommand', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      expect(sub).toBeDefined();
      expect(sub!.description()).toContain('Archive');
    });

    it('should have archive --provider option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find((o) => o.long === '--provider');
      expect(opt).toBeDefined();
    });

    it('should have archive --path option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find((o) => o.long === '--path');
      expect(opt).toBeDefined();
    });

    it('should have archive --agent option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find((o) => o.long === '--agent');
      expect(opt).toBeDefined();
    });

    it('should have archive --subdirectory option with default', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find(
        (o) => o.long === '--subdirectory',
      );
      expect(opt).toBeDefined();
      expect(opt!.defaultValue).toBe('AgentVault-Backups');
    });

    it('should have archive --no-configs option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find((o) => o.long === '--no-configs');
      expect(opt).toBeDefined();
    });

    it('should have archive --no-wallets option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'archive',
      );
      const opt = sub!.options.find((o) => o.long === '--no-wallets');
      expect(opt).toBeDefined();
    });

    it('should have list subcommand', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'list',
      );
      expect(sub).toBeDefined();
      expect(sub!.description()).toContain('List');
    });

    it('should have restore subcommand with argument', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'restore',
      );
      expect(sub).toBeDefined();
      expect(sub!.description()).toContain('Restore');
    });

    it('should have restore --overwrite option', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'restore',
      );
      const opt = sub!.options.find((o) => o.long === '--overwrite');
      expect(opt).toBeDefined();
    });

    it('should have verify subcommand', () => {
      const sub = cloudBackupCmd.commands.find(
        (c) => c.name() === 'verify',
      );
      expect(sub).toBeDefined();
      expect(sub!.description()).toContain('Verify');
    });

    it('should have 5 subcommands total', () => {
      expect(cloudBackupCmd.commands.length).toBe(5);
    });
  });
});
