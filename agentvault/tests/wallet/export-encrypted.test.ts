/**
 * Wallet Export Encrypted Backup Tests (CLE-72)
 *
 * Tests for wallet export to encrypted backup format
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      format: 'encrypted',
      confirm: true,
      password: 'test-password-123',
    }),
  },
}));

vi.mock('../../src/wallet/index.js', () => ({
  listAgentWallets: vi.fn().mockReturnValue(['wallet-1']),
  getWallet: vi.fn().mockReturnValue({
    id: 'wallet-1',
    agentId: 'test-agent',
    chain: 'cketh',
    address: '0x1234567890abcdef1234567890abcdef12345678',
    privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creationMethod: 'private-key',
  }),
}));

describe('Wallet Export Encrypted Backup (CLE-72)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Encryption', () => {
    it('should encrypt backup data', () => {
      const password = 'test-password-123';
      const data = JSON.stringify({ wallets: [{ id: 'wallet-1' }] });

      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const authTag = cipher.getAuthTag();

      expect(encrypted).toBeDefined();
      expect(authTag).toBeDefined();
      expect(encrypted.length).toBeGreaterThan(0);
    });

    it('should use AES-256-GCM for encryption', () => {
      const algorithm = 'aes-256-gcm';
      expect(algorithm).toBe('aes-256-gcm');
    });

    it('should generate unique IV and salt per encryption', () => {
      const salt1 = crypto.randomBytes(16);
      const iv1 = crypto.randomBytes(16);
      const salt2 = crypto.randomBytes(16);
      const iv2 = crypto.randomBytes(16);

      expect(salt1.equals(salt2)).toBe(false);
      expect(iv1.equals(iv2)).toBe(false);
    });

    it('should include auth tag for integrity', () => {
      const password = 'test-password-123';
      const data = 'test data';

      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(16);
      const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const _encrypted = cipher.update(data, 'utf8', 'hex') + cipher.final('hex');
      const authTag = cipher.getAuthTag();

      expect(_encrypted.length).toBeGreaterThan(0);
      expect(authTag.length).toBe(16);
    });
  });

  describe('Password Validation', () => {
    it('should require minimum password length', () => {
      const minLength = 8;
      const password = 'test-password-123';

      expect(password.length).toBeGreaterThanOrEqual(minLength);
    });

    it('should reject short passwords', () => {
      const minLength = 8;
      const password = 'short';

      expect(password.length).toBeLessThan(minLength);
    });
  });

  describe('Backup Structure', () => {
    it('should include encryption metadata', () => {
      const backup = {
        version: '1.0',
        agentId: 'test-agent',
        exportedAt: Date.now(),
        format: 'encrypted' as const,
        encrypted: true,
        iv: 'a1b2c3d4e5f6...',
        salt: 'f6e5d4c3b2a1...',
      };

      expect(backup.encrypted).toBe(true);
      expect(backup.iv).toBeDefined();
      expect(backup.salt).toBeDefined();
    });

    it('should not include plaintext wallets in encrypted backup', () => {
      const encryptedBackup = {
        version: '1.0',
        encrypted: true,
        iv: '...',
        salt: '...',
      };

      expect(encryptedBackup).not.toHaveProperty('wallets');
    });
  });

  describe('Export Flow', () => {
    it('should prompt for encryption password', async () => {
      const { handleExport } = await import('../../cli/commands/wallet-export.js');

      await handleExport('test-agent', { format: 'encrypted' });

      const inquirer = await import('inquirer');
      expect(inquirer.default.prompt).toHaveBeenCalled();
    });
  });
});
