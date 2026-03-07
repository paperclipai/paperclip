/**
 * VetKeys Bundle Encryption — Round-trip and principal-based key tests
 *
 * Acceptance criteria:
 *   1. Round-trip encrypt → decrypt on a sample bundle returns the original
 *   2. Encryption uses principal-based keys (different principals ≠ same key)
 *   3. isVetKeysEncryptedBundle correctly detects encrypted vs. plaintext
 *   4. decryptBundle rejects principal mismatch when enforced
 *   5. Serializer readStateFile auto-decrypts encrypted bundles
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
  encryptBundleWithVetKeys,
  decryptBundle,
  isVetKeysEncryptedBundle,
} from '../../src/security/vetkeys.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';
const OTHER_PRINCIPAL = 'aaaaa-aa';

const SAMPLE_BUNDLE = Buffer.from(
  JSON.stringify({
    $schema: 'https://agentvault.dev/schemas/agent-state-v1.0.0.json',
    version: '1.0.0',
    agent: { name: 'test-agent', type: 'generic' },
    metadata: { createdAt: '2025-01-01T00:00:00.000Z', sourcePath: '/tmp/test', encrypted: true },
    state: {
      initialized: true,
      data: {
        memories: [{ id: 'm1', type: 'fact', content: 'hello world', timestamp: 1, importance: 1 }],
        tasks: [],
        context: {},
      },
    },
  }),
);

// ─── Scenario 1: Round-trip encrypt / decrypt ─────────────────────────────────

describe('Round-trip encrypt / decrypt', () => {
  it('returns the original plaintext after encrypt → decrypt', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    const decrypted = await decryptBundle(encrypted);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });

  it('works with an empty buffer', async () => {
    const empty = Buffer.alloc(0);
    const encrypted = await encryptBundleWithVetKeys(empty, SAMPLE_PRINCIPAL);
    const decrypted = await decryptBundle(encrypted);

    expect(decrypted.length).toBe(0);
  });

  it('works with a large buffer (1 MB random data)', async () => {
    const large = crypto.randomBytes(1024 * 1024);
    const encrypted = await encryptBundleWithVetKeys(large, SAMPLE_PRINCIPAL);
    const decrypted = await decryptBundle(encrypted);

    expect(decrypted.equals(large)).toBe(true);
  });

  it('produces different ciphertexts for the same plaintext (random IV/salt)', async () => {
    const a = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    const b = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);

    // Both decrypt to the same thing
    expect((await decryptBundle(a)).equals(SAMPLE_BUNDLE)).toBe(true);
    expect((await decryptBundle(b)).equals(SAMPLE_BUNDLE)).toBe(true);

    // But the encrypted representations differ
    expect(a.equals(b)).toBe(false);
  });
});

// ─── Scenario 2: Principal-based keys ─────────────────────────────────────────

describe('Principal-based keys', () => {
  it('decrypts successfully when the correct principal is supplied', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    const decrypted = await decryptBundle(encrypted, SAMPLE_PRINCIPAL);

    expect(decrypted.equals(SAMPLE_BUNDLE)).toBe(true);
  });

  it('throws on principal mismatch when an explicit principal is given', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);

    await expect(decryptBundle(encrypted, OTHER_PRINCIPAL)).rejects.toThrow(
      /Principal mismatch/,
    );
  });

  it('a bundle encrypted for principal A cannot be decrypted by tampering the header to principal B', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);

    // Tamper: overwrite the principal field in the header with OTHER_PRINCIPAL
    // This will cause AES-GCM auth to fail because the derived key differs.
    const otherBuf = Buffer.from(OTHER_PRINCIPAL, 'utf-8');
    const principalLenOffset = 4 + 32 + 12 + 16; // magic + salt + iv + tag
    const tampered = Buffer.from(encrypted);

    // Rewrite principal length + principal bytes
    tampered.writeUInt32BE(otherBuf.length, principalLenOffset);
    otherBuf.copy(tampered, principalLenOffset + 4);

    // Decryption should fail with an auth error (wrong key)
    await expect(decryptBundle(tampered)).rejects.toThrow();
  });
});

// ─── Scenario 3: Magic-header detection ───────────────────────────────────────

describe('isVetKeysEncryptedBundle', () => {
  it('returns true for an encrypted bundle', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    expect(isVetKeysEncryptedBundle(encrypted)).toBe(true);
  });

  it('returns false for a plain JSON buffer', () => {
    expect(isVetKeysEncryptedBundle(SAMPLE_BUNDLE)).toBe(false);
  });

  it('returns false for an empty buffer', () => {
    expect(isVetKeysEncryptedBundle(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for random bytes that do not start with VKEB', () => {
    const random = crypto.randomBytes(128);
    // Ensure first 4 bytes are not VKEB
    random[0] = 0x00;
    expect(isVetKeysEncryptedBundle(random)).toBe(false);
  });
});

// ─── Scenario 4: Error handling ───────────────────────────────────────────────

describe('Error handling', () => {
  it('throws when principalId is empty', async () => {
    await expect(
      encryptBundleWithVetKeys(SAMPLE_BUNDLE, ''),
    ).rejects.toThrow(/principalId is required/);
  });

  it('throws when decrypting a non-encrypted buffer', async () => {
    await expect(decryptBundle(SAMPLE_BUNDLE)).rejects.toThrow(
      /missing magic header/,
    );
  });

  it('throws when the encrypted buffer is truncated', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    const truncated = encrypted.subarray(0, 20);

    await expect(decryptBundle(truncated)).rejects.toThrow();
  });

  it('throws when ciphertext is tampered (GCM auth failure)', async () => {
    const encrypted = await encryptBundleWithVetKeys(SAMPLE_BUNDLE, SAMPLE_PRINCIPAL);
    // Flip the last byte (part of ciphertext)
    const tampered = Buffer.from(encrypted);
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;

    await expect(decryptBundle(tampered)).rejects.toThrow();
  });
});
