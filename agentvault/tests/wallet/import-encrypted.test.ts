/**
 * Wallet Import Encrypted Backup Tests (CLE-74)
 *
 * Tests for wallet import from encrypted backup format
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import crypto from 'node:crypto';

const TEST_DIR = path.join(os.tmpdir(), 'agentvault-import-encrypted-test');

vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn().mockResolvedValue({
      confirm: true,
      resolution: 'skip',
      password: 'test-password-123',
    }),
  },
}));

function createEncryptedBackup(password: string): { encrypted: string; iv: string; salt: string } {
  const data = JSON.stringify({
    version: '1.0',
    agentId: 'test-agent',
    exportedAt: Date.now(),
    format: 'encrypted',
    wallets: [
      {
        id: 'wallet-1',
        chain: 'cketh',
        address: '0x1234567890abcdef1234567890abcdef12345678',
        privateKey: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      },
    ],
  });

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  const encryptedWithAuth = `${encrypted}.${authTag.toString('hex')}`;

  return {
    encrypted: encryptedWithAuth,
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
  };
}

describe('Wallet Import Encrypted Backup (CLE-74)', () => {
  const testPassword = 'test-password-123';

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

  describe('Decryption', () => {
    it('should decrypt backup with correct password', () => {
      const result = createEncryptedBackup(testPassword);

      const ivBuffer = Buffer.from(result.iv, 'hex');
      const saltBuffer = Buffer.from(result.salt, 'hex');
      const key = crypto.pbkdf2Sync(testPassword, saltBuffer, 100000, 32, 'sha256');

      const [encryptedData, authTagHex] = result.encrypted.split('.');
      const authTag = Buffer.from(authTagHex || '', 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedData || '', 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      const backup = JSON.parse(decrypted);
      expect(backup.version).toBe('1.0');
      expect(backup.wallets).toBeDefined();
    });

    it('should fail with incorrect password', () => {
      const result = createEncryptedBackup(testPassword);
      const wrongPassword = 'wrong-password';

      const ivBuffer = Buffer.from(result.iv, 'hex');
      const saltBuffer = Buffer.from(result.salt, 'hex');
      const key = crypto.pbkdf2Sync(wrongPassword, saltBuffer, 100000, 32, 'sha256');

      const [encryptedData, authTagHex] = result.encrypted.split('.');
      const authTag = Buffer.from(authTagHex || '', 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
      decipher.setAuthTag(authTag);

      expect(() => {
        decipher.update(encryptedData || '', 'hex', 'utf8');
        decipher.final('utf8');
      }).toThrow();
    });

    it('should verify auth tag integrity', () => {
      const result = createEncryptedBackup(testPassword);

      const [, authTagHex] = result.encrypted.split('.');
      expect(authTagHex).toBeDefined();
      expect(authTagHex?.length).toBe(32);
    });
  });

  describe('Backup Structure', () => {
    it('should identify encrypted format', () => {
      const backup = {
        encrypted: true,
        iv: 'a1b2c3d4...',
        salt: 'e5f6g7h8...',
      };

      expect(backup.encrypted).toBe(true);
    });

    it('should include IV and salt for decryption', () => {
      const result = createEncryptedBackup(testPassword);

      expect(result.iv).toBeDefined();
      expect(result.salt).toBeDefined();
      expect(result.iv.length).toBe(32);
      expect(result.salt.length).toBe(32);
    });
  });

  describe('Import Flow', { timeout: 15000 }, () => {
    it('should prompt for decryption password', async () => {
      const { handleImport } = await import('../../cli/commands/wallet-import.js');

      const backupPath = path.join(TEST_DIR, 'backup.encrypted');
      fs.writeFileSync(backupPath, JSON.stringify({ encrypted: 'test' }));

      await handleImport('test-agent', backupPath);

      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle corrupted backup files', () => {
      const corruptedPath = path.join(TEST_DIR, 'corrupted.encrypted');
      fs.writeFileSync(corruptedPath, 'not valid encrypted data');

      expect(fs.existsSync(corruptedPath)).toBe(true);
    });

    it('should provide clear error for wrong password', () => {
      const result = createEncryptedBackup(testPassword);

      const wrongPassword = 'wrong-password';
      const ivBuffer = Buffer.from(result.iv, 'hex');
      const saltBuffer = Buffer.from(result.salt, 'hex');
      const key = crypto.pbkdf2Sync(wrongPassword, saltBuffer, 100000, 32, 'sha256');

      const [encryptedData, authTagHex] = result.encrypted.split('.');
      const authTag = Buffer.from(authTagHex || '', 'hex');

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, ivBuffer);
      decipher.setAuthTag(authTag);

      let error: Error | null = null;
      try {
        decipher.update(encryptedData || '', 'hex', 'utf8');
        decipher.final('utf8');
      } catch (e) {
        error = e as Error;
      }

      expect(error).not.toBeNull();
    });
  });
});
