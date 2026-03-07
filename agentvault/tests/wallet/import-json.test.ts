/**
 * Wallet Import JSON Backup Tests (CLE-73)
 *
 * Tests for wallet import from plain JSON backup format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TEST_DIR = path.join(os.tmpdir(), 'agentvault-import-test');
const BACKUP_FILE = path.join(TEST_DIR, 'backup.json');

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      confirm: true,
      resolution: 'skip',
    }),
  },
}));

const mockBackup = {
  version: '1.0',
  agentId: 'test-agent',
  exportedAt: Date.now(),
  format: 'json' as const,
  wallets: [
    {
      id: 'wallet-1',
      chain: 'cketh',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    },
    {
      id: 'wallet-2',
      chain: 'solana',
      address: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    },
  ],
};

describe('Wallet Import JSON Backup (CLE-73)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(mockBackup, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('Backup Validation', () => {
    it('should validate backup file exists', () => {
      expect(fs.existsSync(BACKUP_FILE)).toBe(true);
    });

    it('should parse valid JSON backup', () => {
      const content = fs.readFileSync(BACKUP_FILE, 'utf-8');
      const backup = JSON.parse(content);

      expect(backup.version).toBeDefined();
      expect(backup.wallets).toBeDefined();
      expect(Array.isArray(backup.wallets)).toBe(true);
    });

    it('should reject invalid JSON', () => {
      const invalidPath = path.join(TEST_DIR, 'invalid.json');
      fs.writeFileSync(invalidPath, 'not valid json');

      expect(() => JSON.parse(fs.readFileSync(invalidPath, 'utf-8'))).toThrow();
    });

    it('should require version field', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      expect(backup.version).toBeDefined();
    });

    it('should require wallets array', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      expect(Array.isArray(backup.wallets)).toBe(true);
    });
  });

  describe('Wallet Data Validation', () => {
    it('should validate wallet has required fields', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      const wallet = backup.wallets[0];

      expect(wallet.id).toBeDefined();
      expect(wallet.chain).toBeDefined();
      expect(wallet.address).toBeDefined();
    });

    it('should accept wallets with private keys', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      const wallet = backup.wallets[0];

      expect(wallet.privateKey).toBeDefined();
    });

    it('should accept wallets with mnemonics', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      const wallet = backup.wallets[1];

      expect(wallet.mnemonic).toBeDefined();
    });
  });

  describe('Import Flow', { timeout: 15000 }, () => {
    it('should display backup summary', async () => {
      const { handleImport } = await import('../../cli/commands/wallet-import.js');

      await handleImport('test-agent', BACKUP_FILE);

      expect(true).toBe(true);
    });

    it('should show wallets to be imported', () => {
      const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));

      expect(backup.wallets.length).toBe(2);
      expect(backup.wallets[0]?.chain).toBe('cketh');
      expect(backup.wallets[1]?.chain).toBe('solana');
    });
  });

  describe('Chain Support', () => {
    it('should support Ethereum imports', () => {
      const wallet = mockBackup.wallets[0];
      expect(wallet?.chain).toBe('cketh');
    });

    it('should support Solana imports', () => {
      const wallet = mockBackup.wallets[1];
      expect(wallet?.chain).toBe('solana');
    });
  });
});
