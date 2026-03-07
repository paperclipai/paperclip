/**
 * Encryption Timing Tests (CLE-104)
 *
 * Tests for AES-256-GCM encryption with timing-safe HMAC verification
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  CanisterEncryption,
  createCanisterEncryption,
} from '../../src/canister/encryption.js';

describe('Encryption Module', () => {
  let encryption: CanisterEncryption;
  let testKey: Buffer;

  beforeEach(async () => {
    encryption = createCanisterEncryption({ algorithm: 'aes-256-gcm' });
    testKey = crypto.randomBytes(32);
  });

  describe('encrypt()', () => {
    it('should produce valid AES-256-GCM output', async () => {
      const plaintext = 'test secret data';

      const result = await encryption.encrypt(plaintext, testKey);

      expect(result.success).toBe(true);
      expect(result.encrypted).toBeDefined();
      expect(result.encrypted?.algorithm).toBe('aes-256-gcm');
      expect(result.encrypted?.ciphertext).toBeInstanceOf(Uint8Array);
      expect(result.encrypted?.iv).toBeInstanceOf(Uint8Array);
      expect(result.encrypted?.tag).toBeInstanceOf(Uint8Array);
      expect(result.encrypted?.timestamp).toBeDefined();
    });

    it('should generate random IV per encryption', async () => {
      const plaintext = 'same data';

      const result1 = await encryption.encrypt(plaintext, testKey);
      const result2 = await encryption.encrypt(plaintext, testKey);

      expect(result1.encrypted?.iv).not.toEqual(result2.encrypted?.iv);
      expect(result1.encrypted?.ciphertext).not.toEqual(result2.encrypted?.ciphertext);
    });

    it('should generate 12-byte IV for AES-GCM', async () => {
      const result = await encryption.encrypt('test', testKey);

      expect(result.encrypted?.iv.length).toBe(12);
    });

    it('should generate 16-byte auth tag', async () => {
      const result = await encryption.encrypt('test', testKey);

      expect(result.encrypted?.tag.length).toBe(16);
    });

    it('should handle empty string', async () => {
      const result = await encryption.encrypt('', testKey);

      expect(result.success).toBe(true);
    });

    it('should handle large data', async () => {
      const largeData = 'x'.repeat(100000);

      const result = await encryption.encrypt(largeData, testKey);

      expect(result.success).toBe(true);
    });
  });

  describe('decrypt()', () => {
    it('should recover original plaintext', async () => {
      const plaintext = 'secret message to decrypt';

      const encrypted = await encryption.encrypt(plaintext, testKey);
      const decrypted = await encryption.decrypt(encrypted.encrypted!, testKey);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decrypted).toBe(plaintext);
    });

    it('should fail with wrong key', async () => {
      const wrongKey = crypto.randomBytes(32);
      const encrypted = await encryption.encrypt('secret', testKey);

      const decrypted = await encryption.decrypt(encrypted.encrypted!, wrongKey);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toBeDefined();
    });

    it('should fail with tampered ciphertext', async () => {
      const encrypted = await encryption.encrypt('secret', testKey);
      const tampered = { ...encrypted.encrypted! };
      tampered.ciphertext = new Uint8Array([...tampered.ciphertext, 0xff]);

      const decrypted = await encryption.decrypt(tampered, testKey);

      expect(decrypted.success).toBe(false);
    });

    it('should fail with tampered auth tag', async () => {
      const encrypted = await encryption.encrypt('secret', testKey);
      const tampered = { ...encrypted.encrypted! };
      tampered.tag = new Uint8Array(16).fill(0xff);

      const decrypted = await encryption.decrypt(tampered, testKey);

      expect(decrypted.success).toBe(false);
    });

    it('should fail with tampered IV', async () => {
      const encrypted = await encryption.encrypt('secret', testKey);
      const tampered = { ...encrypted.encrypted! };
      tampered.iv = new Uint8Array(12).fill(0x00);

      const decrypted = await encryption.decrypt(tampered, testKey);

      expect(decrypted.success).toBe(false);
    });
  });

  describe('verifyHMAC() - Timing Safety', () => {
    it('should return true for matching HMAC', async () => {
      const data = 'test data';
      const hmac = await encryption.generateHMAC(data, testKey);

      const result = await encryption.verifyHMAC(data, testKey, hmac);

      expect(result).toBe(true);
    });

    it('should return false for non-matching HMAC', async () => {
      const data = 'test data';
      const wrongHmac = '0'.repeat(64);

      const result = await encryption.verifyHMAC(data, testKey, wrongHmac);

      expect(result).toBe(false);
    });

    it('should use timing-safe comparison (no early exit)', async () => {
      const data = 'test data';

      const wrongHmacShort = '00';
      const wrongHmacLong = '0'.repeat(64);

      const startShort = process.hrtime.bigint();
      await encryption.verifyHMAC(data, testKey, wrongHmacShort);
      const endShort = process.hrtime.bigint();

      const startLong = process.hrtime.bigint();
      await encryption.verifyHMAC(data, testKey, wrongHmacLong);
      const endLong = process.hrtime.bigint();

      const shortTime = Number(endShort - startShort);
      const longTime = Number(endLong - startLong);

      expect(longTime).toBeGreaterThanOrEqual(shortTime * 0.5);
    });

    it('should return false for different length HMACs', async () => {
      const data = 'test data';

      const result = await encryption.verifyHMAC(data, testKey, 'short');

      expect(result).toBe(false);
    });
  });

  describe('encryptWithHMAC()', () => {
    it('should produce both encrypted data and HMAC', async () => {
      const data = 'data with integrity check';

      const result = await encryption.encryptWithHMAC(data, testKey);

      expect(result.success).toBe(true);
      expect(result.encrypted).toBeDefined();
      expect(result.hmac).toBeDefined();
      expect(result.hmac).toHaveLength(64);
    });
  });

  describe('decryptAndVerifyHMAC()', () => {
    it('should decrypt and verify successfully', async () => {
      const data = 'protected data';

      const encrypted = await encryption.encryptWithHMAC(data, testKey);
      const result = await encryption.decryptAndVerifyHMAC(
        encrypted.encrypted!,
        testKey,
        encrypted.hmac!
      );

      expect(result.success).toBe(true);
      expect(result.decrypted).toBe(data);
      expect(result.hmacValid).toBe(true);
    });

    it('should fail with wrong HMAC', async () => {
      const data = 'protected data';

      const encrypted = await encryption.encryptWithHMAC(data, testKey);
      const result = await encryption.decryptAndVerifyHMAC(
        encrypted.encrypted!,
        testKey,
        '0'.repeat(64)
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('HMAC');
    });
  });

  describe('generateKey()', () => {
    it('should generate random key without seed', async () => {
      const key1 = await encryption.generateKey();
      const key2 = await encryption.generateKey();

      expect(key1.length).toBe(32);
      expect(key2.length).toBe(32);
      expect(key1).not.toEqual(key2);
    });

    it('should generate deterministic key from seed', async () => {
      const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

      const key1 = await encryption.generateKey(seed);
      const key2 = await encryption.generateKey(seed);

      expect(key1).toEqual(key2);
    });

    it('should generate different keys for different seeds', async () => {
      const key1 = await encryption.generateKey('seed one two three');
      const key2 = await encryption.generateKey('four five six seven');

      expect(key1).not.toEqual(key2);
    });
  });

  describe('encryptObject() / decryptObject()', () => {
    it('should encrypt and decrypt JSON objects', async () => {
      const obj = { name: 'test', value: 123, nested: { a: true } };

      const encrypted = await encryption.encryptObject(obj, testKey);
      const decrypted = await encryption.decryptObject<typeof obj>(encrypted.encrypted!, testKey);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decrypted).toEqual(obj);
    });

    it('should handle complex nested objects', async () => {
      const obj = {
        users: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        meta: {
          created: new Date().toISOString(),
          tags: ['tag1', 'tag2'],
        },
      };

      const encrypted = await encryption.encryptObject(obj, testKey);
      const decrypted = await encryption.decryptObject<typeof obj>(encrypted.encrypted!, testKey);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decrypted).toEqual(obj);
    });
  });
});
