/**
 * Wallet Crypto Tests
 *
 * Covers secp256k1 / Ed25519 key generation, AES-256-GCM encryption, and
 * the wallet-level encrypt/decrypt helpers in wallet-crypto.ts.
 */

import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import {
  secp256k1KeypairFromSeed,
  ed25519KeypairFromSeed,
  deriveStorageKey,
  encryptSecret,
  decryptSecret,
  encryptWalletSecrets,
  decryptWalletSecrets,
} from '../../src/wallet/wallet-crypto.js';
import type { WalletData } from '../../src/wallet/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function makeSeed(size = 32): Uint8Array {
  // Deterministic seed for reproducible tests
  return new Uint8Array(crypto.createHash('sha256').update('test-seed').digest()).slice(0, size);
}

function makeWallet(overrides: Partial<WalletData> = {}): WalletData {
  return {
    id: 'wallet-test-001',
    agentId: 'agent-test',
    chain: 'cketh',
    address: '0xdeadbeef',
    privateKey: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    mnemonic: TEST_MNEMONIC,
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    creationMethod: 'seed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// secp256k1KeypairFromSeed
// ---------------------------------------------------------------------------

describe('secp256k1KeypairFromSeed()', () => {
  it('returns a 32-byte private key', () => {
    const seed = makeSeed(32);
    const { privateKey } = secp256k1KeypairFromSeed(seed);
    expect(privateKey).toHaveLength(32);
  });

  it('returns a 65-byte uncompressed public key', () => {
    const seed = makeSeed(32);
    const { publicKeyUncompressed } = secp256k1KeypairFromSeed(seed);
    expect(publicKeyUncompressed).toHaveLength(65);
    expect(publicKeyUncompressed[0]).toBe(0x04); // uncompressed prefix
  });

  it('returns a 33-byte compressed public key', () => {
    const seed = makeSeed(32);
    const { publicKeyCompressed } = secp256k1KeypairFromSeed(seed);
    expect(publicKeyCompressed).toHaveLength(33);
    expect([0x02, 0x03]).toContain(publicKeyCompressed[0]);
  });

  it('is deterministic for the same seed', () => {
    const seed = makeSeed(32);
    const kp1 = secp256k1KeypairFromSeed(seed);
    const kp2 = secp256k1KeypairFromSeed(seed);
    expect(Buffer.from(kp1.privateKey).toString('hex')).toBe(
      Buffer.from(kp2.privateKey).toString('hex')
    );
    expect(Buffer.from(kp1.publicKeyUncompressed).toString('hex')).toBe(
      Buffer.from(kp2.publicKeyUncompressed).toString('hex')
    );
  });

  it('produces different keypairs for different seeds', () => {
    const kp1 = secp256k1KeypairFromSeed(makeSeed(32));
    // 0x02 repeated – well within [1..n-1] for secp256k1
    const kp2 = secp256k1KeypairFromSeed(new Uint8Array(32).fill(0x02));
    expect(Buffer.from(kp1.privateKey).toString('hex')).not.toBe(
      Buffer.from(kp2.privateKey).toString('hex')
    );
  });
});

// ---------------------------------------------------------------------------
// ed25519KeypairFromSeed
// ---------------------------------------------------------------------------

describe('ed25519KeypairFromSeed()', () => {
  it('returns a 32-byte private key', () => {
    const { privateKey } = ed25519KeypairFromSeed(makeSeed(32));
    expect(privateKey).toHaveLength(32);
  });

  it('returns a 32-byte public key', () => {
    const { publicKey } = ed25519KeypairFromSeed(makeSeed(32));
    expect(publicKey).toHaveLength(32);
  });

  it('is deterministic for the same seed', () => {
    const seed = makeSeed(32);
    const kp1 = ed25519KeypairFromSeed(seed);
    const kp2 = ed25519KeypairFromSeed(seed);
    expect(Buffer.from(kp1.publicKey).toString('hex')).toBe(
      Buffer.from(kp2.publicKey).toString('hex')
    );
  });

  it('produces different keypairs for different seeds', () => {
    const kp1 = ed25519KeypairFromSeed(makeSeed(32));
    const kp2 = ed25519KeypairFromSeed(new Uint8Array(32).fill(0x42));
    expect(Buffer.from(kp1.publicKey).toString('hex')).not.toBe(
      Buffer.from(kp2.publicKey).toString('hex')
    );
  });
});

// ---------------------------------------------------------------------------
// deriveStorageKey
// ---------------------------------------------------------------------------

describe('deriveStorageKey()', () => {
  it('returns a 32-byte key', () => {
    const salt = crypto.randomBytes(32);
    const key = deriveStorageKey(TEST_MNEMONIC, salt);
    expect(key).toHaveLength(32);
  });

  it('is deterministic for the same mnemonic + salt', () => {
    const salt = Buffer.alloc(32, 0x11);
    const k1 = deriveStorageKey(TEST_MNEMONIC, salt);
    const k2 = deriveStorageKey(TEST_MNEMONIC, salt);
    expect(k1.toString('hex')).toBe(k2.toString('hex'));
  });

  it('produces different keys for different salts', () => {
    const salt1 = crypto.randomBytes(32);
    const salt2 = crypto.randomBytes(32);
    const k1 = deriveStorageKey(TEST_MNEMONIC, salt1);
    const k2 = deriveStorageKey(TEST_MNEMONIC, salt2);
    expect(k1.toString('hex')).not.toBe(k2.toString('hex'));
  });

  it('produces different keys for different mnemonics', () => {
    const salt = Buffer.alloc(32, 0x22);
    const k1 = deriveStorageKey(TEST_MNEMONIC, salt);
    const k2 = deriveStorageKey('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong', salt);
    expect(k1.toString('hex')).not.toBe(k2.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// encryptSecret / decryptSecret
// ---------------------------------------------------------------------------

describe('encryptSecret() / decryptSecret()', () => {
  it('round-trips a private key hex string', () => {
    const key = crypto.randomBytes(32);
    const plaintext = 'deadbeef'.repeat(8); // 64 hex chars
    const enc = encryptSecret(plaintext, key);
    expect(decryptSecret(enc, key)).toBe(plaintext);
  });

  it('round-trips a BIP39 mnemonic', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret(TEST_MNEMONIC, key);
    expect(decryptSecret(enc, key)).toBe(TEST_MNEMONIC);
  });

  it('produces different ciphertext each call (random IV)', () => {
    const key = crypto.randomBytes(32);
    const enc1 = encryptSecret('same plaintext', key);
    const enc2 = encryptSecret('same plaintext', key);
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
  });

  it('includes a 12-byte IV (24 hex chars)', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret('data', key);
    expect(enc.iv).toHaveLength(24);
  });

  it('includes a 16-byte auth tag (32 hex chars)', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret('data', key);
    expect(enc.tag).toHaveLength(32);
  });

  it('throws on wrong decryption key (GCM auth failure)', () => {
    const key = crypto.randomBytes(32);
    const wrongKey = crypto.randomBytes(32);
    const enc = encryptSecret('secret', key);
    expect(() => decryptSecret(enc, wrongKey)).toThrow();
  });

  it('throws on tampered ciphertext', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret('secret', key);
    const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -2) + 'ff' };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const key = crypto.randomBytes(32);
    const enc = encryptSecret('secret', key);
    const tampered = { ...enc, tag: 'ff'.repeat(16) };
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// encryptWalletSecrets
// ---------------------------------------------------------------------------

describe('encryptWalletSecrets()', () => {
  it('removes plaintext privateKey and mnemonic', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(encrypted.privateKey).toBeUndefined();
    expect(encrypted.mnemonic).toBeUndefined();
  });

  it('populates encryptedSecrets bundle', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(encrypted.encryptedSecrets).toBeDefined();
    expect(encrypted.encryptedSecrets?.version).toBe(1);
    expect(encrypted.encryptedSecrets?.salt).toHaveLength(64); // 32 bytes as hex
    expect(encrypted.encryptedSecrets?.privateKey).toBeDefined();
    expect(encrypted.encryptedSecrets?.mnemonic).toBeDefined();
  });

  it('does not mutate the original wallet', () => {
    const wallet = makeWallet();
    const original = { ...wallet };
    encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(wallet.privateKey).toBe(original.privateKey);
    expect(wallet.mnemonic).toBe(original.mnemonic);
  });

  it('preserves non-sensitive fields', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(encrypted.id).toBe(wallet.id);
    expect(encrypted.agentId).toBe(wallet.agentId);
    expect(encrypted.chain).toBe(wallet.chain);
    expect(encrypted.address).toBe(wallet.address);
    expect(encrypted.createdAt).toBe(wallet.createdAt);
  });

  it('handles wallet with only privateKey (no mnemonic)', () => {
    const wallet = makeWallet({ mnemonic: undefined });
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(encrypted.encryptedSecrets?.privateKey).toBeDefined();
    expect(encrypted.encryptedSecrets?.mnemonic).toBeUndefined();
  });

  it('handles wallet with only mnemonic (no privateKey)', () => {
    const wallet = makeWallet({ privateKey: undefined });
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(encrypted.encryptedSecrets?.mnemonic).toBeDefined();
    expect(encrypted.encryptedSecrets?.privateKey).toBeUndefined();
  });

  it('uses a fresh random salt each time', () => {
    const wallet = makeWallet();
    const enc1 = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    const enc2 = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(enc1.encryptedSecrets?.salt).not.toBe(enc2.encryptedSecrets?.salt);
  });
});

// ---------------------------------------------------------------------------
// decryptWalletSecrets
// ---------------------------------------------------------------------------

describe('decryptWalletSecrets()', () => {
  it('recovers original privateKey', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    const decrypted = decryptWalletSecrets(encrypted, TEST_MNEMONIC);
    expect(decrypted.privateKey).toBe(wallet.privateKey);
  });

  it('recovers original mnemonic', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    const decrypted = decryptWalletSecrets(encrypted, TEST_MNEMONIC);
    expect(decrypted.mnemonic).toBe(wallet.mnemonic);
  });

  it('returns wallet unchanged when no encryptedSecrets', () => {
    const wallet = makeWallet();
    const result = decryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(result.privateKey).toBe(wallet.privateKey);
    expect(result.mnemonic).toBe(wallet.mnemonic);
  });

  it('throws when wrong mnemonic is supplied', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    expect(() =>
      decryptWalletSecrets(encrypted, 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong')
    ).toThrow();
  });

  it('preserves non-sensitive fields after round-trip', () => {
    const wallet = makeWallet();
    const encrypted = encryptWalletSecrets(wallet, TEST_MNEMONIC);
    const decrypted = decryptWalletSecrets(encrypted, TEST_MNEMONIC);
    expect(decrypted.id).toBe(wallet.id);
    expect(decrypted.chain).toBe(wallet.chain);
    expect(decrypted.address).toBe(wallet.address);
    expect(decrypted.createdAt).toBe(wallet.createdAt);
  });
});
