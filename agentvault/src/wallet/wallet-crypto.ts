/**
 * Wallet Crypto Module
 *
 * Provides cryptographic primitives for wallet key generation and at-rest
 * encryption using industry-standard algorithms:
 *
 *   - secp256k1 ECDSA (Ethereum / Polkadot) via @noble/curves
 *   - Ed25519 EdDSA (Solana / ICP / Arweave)  via @noble/curves
 *   - AES-256-GCM authenticated encryption for private keys / mnemonics
 *   - PBKDF2-SHA256 (210 000 iterations) for storage-key derivation
 *
 * Private keys and mnemonics are NEVER stored in plaintext.  When a
 * caller supplies an encryptionKey (the wallet's BIP39 mnemonic) the
 * sensitive fields are encrypted into an EncryptedKeyBundle before the
 * wallet is written to disk.
 */

import * as crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import type { EncryptedCiphertext, EncryptedKeyBundle, WalletData } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** PBKDF2 iteration count – OWASP 2023 recommendation for SHA-256 */
const PBKDF2_ITERATIONS = 210_000;

/** AES-256-GCM key length in bytes */
const AES_KEY_BYTES = 32;

/** AES-256-GCM IV length in bytes */
const GCM_IV_BYTES = 12;

/** PBKDF2 salt length in bytes */
const SALT_BYTES = 32;

// ---------------------------------------------------------------------------
// Key-generation helpers (exported for use in key-derivation.ts)
// ---------------------------------------------------------------------------

/**
 * Derive a secp256k1 keypair from a 32-byte seed.
 *
 * Uses @noble/curves/secp256k1 – the same underlying library used by ethers
 * and most modern JS wallets.  The uncompressed public key (65 bytes,
 * 0x04 prefix) is returned so callers can choose their own encoding.
 *
 * @param seed - 32 bytes of key material (e.g. from BIP32 derivation)
 */
export function secp256k1KeypairFromSeed(seed: Uint8Array): {
  privateKey: Uint8Array;
  publicKeyUncompressed: Uint8Array;
  publicKeyCompressed: Uint8Array;
} {
  const privateKey = seed.slice(0, 32);
  const publicKeyUncompressed = secp256k1.getPublicKey(privateKey, false);
  const publicKeyCompressed = secp256k1.getPublicKey(privateKey, true);
  return { privateKey, publicKeyUncompressed, publicKeyCompressed };
}

/**
 * Derive an Ed25519 keypair from a 32-byte seed.
 *
 * Uses @noble/curves/ed25519.  The private key is the raw 32-byte seed;
 * the public key is the 32-byte Ed25519 point.
 *
 * @param seed - 32 bytes of key material
 */
export function ed25519KeypairFromSeed(seed: Uint8Array): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const privateKey = seed.slice(0, 32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// ---------------------------------------------------------------------------
// Storage-key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a 32-byte AES-256-GCM key from a BIP39 mnemonic and a random salt
 * using PBKDF2-SHA256.
 *
 * The per-wallet salt ensures that two wallets encrypted with the same
 * mnemonic produce independent keys, preventing cross-wallet key reuse.
 *
 * @param mnemonic - BIP39 mnemonic (the wallet owner's seed phrase)
 * @param salt     - 32-byte random per-wallet salt (stored alongside ciphertext)
 */
export function deriveStorageKey(mnemonic: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(mnemonic, salt, PBKDF2_ITERATIONS, AES_KEY_BYTES, 'sha256');
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 plaintext string with AES-256-GCM.
 *
 * A fresh 12-byte IV is generated for every call.  The authentication tag
 * is stored alongside the ciphertext so that any tampering is detected on
 * decryption.
 *
 * @param plaintext - The string to encrypt (private key hex or mnemonic)
 * @param key       - 32-byte AES key (output of deriveStorageKey)
 */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedCiphertext {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt an AES-256-GCM ciphertext produced by encryptSecret.
 *
 * Throws if the authentication tag does not match (tamper detection).
 *
 * @param encrypted - EncryptedCiphertext produced by encryptSecret
 * @param key       - 32-byte AES key (must match the key used for encryption)
 */
export function decryptSecret(encrypted: EncryptedCiphertext, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'hex')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// Wallet-level encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a wallet's sensitive fields (privateKey and/or mnemonic) using
 * AES-256-GCM with a key derived from the supplied mnemonic + a fresh
 * random salt.
 *
 * The returned wallet has:
 *   - privateKey  set to undefined
 *   - mnemonic    set to undefined
 *   - encryptedSecrets populated with the ciphertext bundle
 *
 * The in-memory wallet object passed in is not mutated.
 *
 * @param wallet   - Wallet whose secrets should be encrypted
 * @param mnemonic - BIP39 mnemonic used as key-derivation material
 */
export function encryptWalletSecrets(wallet: WalletData, mnemonic: string): WalletData {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = deriveStorageKey(mnemonic, salt);

  const bundle: EncryptedKeyBundle = {
    version: 1,
    salt: salt.toString('hex'),
  };

  if (wallet.privateKey) {
    bundle.privateKey = encryptSecret(wallet.privateKey, key);
  }
  if (wallet.mnemonic) {
    bundle.mnemonic = encryptSecret(wallet.mnemonic, key);
  }

  return {
    ...wallet,
    privateKey: undefined,
    mnemonic: undefined,
    encryptedSecrets: bundle,
  };
}

/**
 * Decrypt a wallet's EncryptedKeyBundle back into plaintext fields.
 *
 * If the wallet has no encryptedSecrets the wallet is returned unchanged.
 * Throws if the mnemonic is wrong (AES-GCM authentication will fail).
 *
 * @param wallet   - Wallet with encryptedSecrets populated
 * @param mnemonic - BIP39 mnemonic used as key-derivation material
 */
export function decryptWalletSecrets(wallet: WalletData, mnemonic: string): WalletData {
  if (!wallet.encryptedSecrets) {
    return wallet;
  }

  const { encryptedSecrets } = wallet;
  const salt = Buffer.from(encryptedSecrets.salt, 'hex');
  const key = deriveStorageKey(mnemonic, salt);

  const decrypted: Partial<Pick<WalletData, 'privateKey' | 'mnemonic'>> = {};

  if (encryptedSecrets.privateKey) {
    decrypted.privateKey = decryptSecret(encryptedSecrets.privateKey, key);
  }
  if (encryptedSecrets.mnemonic) {
    decrypted.mnemonic = decryptSecret(encryptedSecrets.mnemonic, key);
  }

  return { ...wallet, ...decrypted };
}
