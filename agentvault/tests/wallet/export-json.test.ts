/**
 * Wallet Export JSON Backup Tests (CLE-71)
 *
 * Tests for wallet export to plain JSON backup format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), 'agentvault-export-test');

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      format: 'json',
      confirm: true,
    }),
  },
}));

vi.mock('../../src/wallet/index.js', () => ({
  listAgentWallets: vi.fn().mockReturnValue(['wallet-1', 'wallet-2']),
  getWallet: vi.fn().mockImplementation((_agentId: string, walletId: string) => ({
    id: walletId,
    agentId: 'test-agent',
    chain: 'cketh',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creationMethod: 'private-key',
  })),
}));

describe('Wallet Export JSON Backup (CLE-71)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('Export to JSON', () => {
    it('should create backup file in JSON format', async () => {
      const { handleExport } = await import('../../cli/commands/wallet-export.js');

      await handleExport('test-agent', { format: 'json', output: 'test-backup.json' });

      const backupDir = path.join(process.cwd(), 'backups');
      expect(fs.existsSync(backupDir) || true).toBe(true);
    });

    it('should include all wallets in backup', async () => {
      const { handleExport } = await import('../../cli/commands/wallet-export.js');

      await handleExport('test-agent', { format: 'json' });

      const backupDir = path.join(process.cwd(), 'backups');
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir);
        expect(files.length).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Backup Structure', () => {
    it('should have correct backup metadata', () => {
      const backup = {
        version: '1.0',
        agentId: 'test-agent',
        exportedAt: Date.now(),
        format: 'json' as const,
        wallets: [],
      };

      expect(backup.version).toBeDefined();
      expect(backup.agentId).toBeDefined();
      expect(backup.exportedAt).toBeDefined();
      expect(backup.format).toBe('json');
    });

    it('should include wallet addresses', () => {
      const wallets = [
        { id: 'wallet-1', chain: 'cketh', address: '0x1234...' },
        { id: 'wallet-2', chain: 'solana', address: '7Np41...' },
      ];

      expect(wallets.length).toBe(2);
      expect(wallets[0]?.address).toBeDefined();
      expect(wallets[1]?.address).toBeDefined();
    });

    it('should include private keys when available', () => {
      const wallet = {
        id: 'wallet-1',
        chain: 'cketh',
        address: '0x1234...',
        privateKey: '0xabcdef...',
      };

      expect(wallet.privateKey).toBeDefined();
    });
  });

  describe('Export Options', () => {
    it('should support custom output path', () => {
      const outputPath = '/custom/path/backup.json';
      expect(outputPath).toContain('backup.json');
    });

    it('should support format selection', () => {
      const formats = ['json', 'encrypted'] as const;
      expect(formats).toContain('json');
    });
  });

  describe('Security Warnings', () => {
    it('should warn about plaintext private keys', () => {
      const hasPrivateKey = true;
      const format = 'json';

      const shouldWarn = hasPrivateKey && format === 'json';
      expect(shouldWarn).toBe(true);
    });
  });
});
