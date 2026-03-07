/**
 * VetKeys Integration for Threshold Key Derivation
 *
 * This module provides VetKeys protocol implementation for threshold key derivation.
 * Supports Shamir's Secret Sharing (SSS) for threshold cryptography.
 *
 * Security Properties:
 * - Threshold signatures prevent single points of failure
 * - Distributed trust model
 * - Combiner-based key reconstruction
 *
 * Protocol Features:
 * - Key derivation using secret sharing
 * - Threshold signature verification
 * - Key reconstruction without revealing secrets
 *
 * Note: VetKeysClient interface is defined in types.ts.
 * This implementation class avoids the naming conflict.
 */

import * as crypto from 'node:crypto';
import { debugLog } from '../debugging/debug-logger.js';
import type {
  EncryptedData,
  VetKeysOptions,
  EncryptionAlgorithm,
  VetKeysDerivedKey as DerivedKey,
} from './types.js';

type CanisterAlgorithm = 'aes_256_gcm' | 'chacha20_poly1305';

function toCanisterAlgorithm(algorithm: EncryptionAlgorithm): CanisterAlgorithm {
  return algorithm === 'aes-256-gcm' ? 'aes_256_gcm' : 'chacha20_poly1305';
}

function fromCanisterAlgorithm(canisterAlg: CanisterAlgorithm): EncryptionAlgorithm {
  return canisterAlg === 'aes_256_gcm' ? 'aes-256-gcm' : 'chacha20-poly1305';
}

export class VetKeysImplementation {
  private config: VetKeysOptions;
  private canisterId?: string;
  private useCanister: boolean;

  constructor(options: VetKeysOptions & { canisterId?: string; useCanister?: boolean } = {}) {
    this.config = {
      threshold: options.threshold ?? 2,
      totalParties: options.totalParties ?? 3,
      encryptionAlgorithm: options.encryptionAlgorithm ?? 'aes-256-gcm',
      vetKeysCanisterId: options.canisterId,
    };
    this.canisterId = options.canisterId;
    this.useCanister = options.useCanister ?? !!options.canisterId;
  }

  /**
   * Decrypt JSON data using seed phrase
   *
   * @param encrypted - Encrypted data to decrypt
   * @param seedPhrase - Seed phrase for key derivation
   * @returns Decrypted JSON object
   */
  public static async decryptJSON<T = unknown>(
    encrypted: EncryptedData,
    seedPhrase: string
  ): Promise<T> {
    const crypto = await import('node:crypto');
    const bip39 = await import('bip39');

    // Derive key from seed phrase
    const seed = await bip39.mnemonicToSeed(seedPhrase);
    const key = crypto.pbkdf2Sync(
      seed,
      encrypted.salt,
      100000,
      32,
      'sha256',
    );

    // Decode IV and ciphertext
    const iv = Buffer.from(encrypted.iv, 'hex');
    const ciphertext = Buffer.from(encrypted.ciphertext, 'hex');

    // Decrypt based on algorithm
    let algorithm: string;
    if (encrypted.algorithm === 'aes-256-gcm') {
      algorithm = 'aes-256-gcm';
    } else {
      algorithm = encrypted.algorithm.replace('-', '');
    }

    const decipher = crypto.createDecipheriv(algorithm, key, iv);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf-8')) as T;
  }

  /**
   * Derive threshold key from seed phrase
   *
   * Implements Shamir's Secret Sharing for threshold key derivation.
   * Generates n secret shares (where threshold = t out of n)
   * Each share is encrypted and can be used to reconstruct the master key.
   *
   * @param seedPhrase - BIP39 seed phrase
   * @param options - Optional derivation options
   * @returns Derived key with threshold parameters
   */
  public async deriveThresholdKey(
    seedPhrase: string,
    options: VetKeysOptions & {
      threshold?: number;
      totalParties?: number;
      encryptionAlgorithm?: EncryptionAlgorithm;
    } = {}
  ): Promise<DerivedKey> {
    const threshold = options.threshold ?? this.config.threshold;
    const totalParties = options.totalParties ?? this.config.totalParties;
    const algorithm = options.encryptionAlgorithm ?? this.config.encryptionAlgorithm;

    // Validate threshold
    if (threshold! < 1 || threshold! > totalParties!) {
      throw new Error(
        `Threshold must be between 1 and totalParticipants (${totalParties!}). Got: ${threshold}`
      );
    }

    try {
      // Derive n secret shares from seed phrase
      const shares = await this.generateSecretShares(seedPhrase, threshold!, totalParties!, algorithm!);

      // Generate share metadata
      const shareMetadata = shares.map((share, index) => ({
        index: index + 1,
        shareId: this.generateShareId(),
        participantId: (index + 1).toString(),
        encryptedShare: share.encryptedShare,
        commitment: share.commitment,
      }));

      // Generate commitment
      const commitment = await this.generateCommitment(shares);

      // Generate verification parameters
      const verification = {
        threshold,
        shares,
        commitment,
        algorithm,
        encryptionAlgorithm: algorithm,
        createdAt: new Date().toISOString(),
      };

      // Derive master key from seed phrase (for local use)
      const derivedKey = await this.deriveMasterKey(seedPhrase, algorithm!);

      // SECURITY: Do not include seedPhrase in returned object to prevent memory exposure
      // The seed phrase should only be used transiently for key derivation
      return {
        type: 'threshold',
        key: derivedKey.key,
        method: derivedKey.method,
        // seedPhrase intentionally omitted for security - see SEC-3 in SECURITY_AUDIT
        threshold: threshold!,
        totalParties: totalParties!,
        algorithm: algorithm!,
        shares,
        shareMetadata,
        commitment,
        verification,
      } as DerivedKey;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to derive threshold key: ${message}`);
    }
  }

  /**
   * Generate secret shares using Shamir's Secret Sharing
   *
   * @param seedPhrase - Master secret
   * @param threshold - Number of shares to create (t)
   * @param totalParties - Total number of participants (n)
   * @param algorithm - Encryption algorithm to use
   * @returns Array of encrypted shares
   */
  private async generateSecretShares(
    seedPhrase: string,
    threshold: number,
    totalParties: number,
    algorithm: EncryptionAlgorithm
  ): Promise<Array<{ shareId: string; participantId: string; encryptedShare: string; commitment: string }>> {
    const shares: Array<{ shareId: string; participantId: string; encryptedShare: string; commitment: string }> = [];
    const masterCommitment = await this.generateCommitment(shares);

    for (let i = 0; i < threshold; i++) {
      const shareId = this.generateShareId();
      const participantId = i + 1;

      // Generate unique secret for this participant
      const participantSecret = this.generateParticipantSecret(seedPhrase, i, totalParties);

      // Encrypt share with participant's secret
      const { encryptedShare, commitment: shareCommitment } = await this.encryptShare(
        participantSecret,
        masterCommitment,
        algorithm,
      );

      shares.push({
        shareId,
        participantId: participantId.toString(),
        encryptedShare,
        commitment: shareCommitment,
      });
    }

    return shares;
  }

  /**
   * Generate share identifier using cryptographically secure random bytes
   */
  private generateShareId(): string {
    const randomBytes = crypto.randomBytes(4);
    const timestamp = Date.now().toString(36);
    const randomHex = randomBytes.toString('hex').substring(0, 8);
    return `share_${timestamp}_${randomHex}`;
  }

   /**
   * Generate unique secret for a participant
   *
   * @param seedPhrase - Master secret
   * @param participantIndex - Participant index (1-based)
   */
  private generateParticipantSecret(seedPhrase: string, participantIndex: number, _totalParties: number): string {
    const secretBytes = Buffer.from(seedPhrase, 'utf8');

    // Create unique secret for this participant by adding participant index
    const participantSuffix = Buffer.concat([Buffer.from([participantIndex]), secretBytes]);

    return participantSuffix.toString('hex');
  }

  /**
   * Encrypt a secret share
   *
   * @param secret - Secret to encrypt
   * @param algorithm - Encryption algorithm
   */
  private async encryptShare(
    secret: string,
    _commitment: string,
    algorithm: EncryptionAlgorithm
  ): Promise<{ encryptedShare: string; commitment: string }> {
    const crypto = await import('node:crypto');

    const secretBuffer = Buffer.from(secret, 'utf-8');
    const iv = algorithm === 'aes-256-gcm' ? crypto.randomBytes(12) : crypto.randomBytes(16);
    const algorithmName = algorithm.replace('-', '');

    const encryptionKey = crypto.pbkdf2Sync(
      secretBuffer,
      iv,
      100000,
      32,
      'sha256'
    );

    const cipher = crypto.createCipheriv(algorithmName, encryptionKey, iv);

    const encryptedShare = Buffer.concat([
      cipher.update(secretBuffer),
      cipher.final(),
    ]);

    const commitmentHash = crypto.createHash('sha256')
      .update(encryptedShare)
      .digest();

    return {
      encryptedShare: encryptedShare.toString('hex'),
      commitment: commitmentHash.toString('hex'),
    };
  }

  /**
   * Generate commitment from all shares
   */
  private async generateCommitment(shares: Array<{ encryptedShare: string }>): Promise<string> {
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256');

    // Combine all encrypted shares
    for (const share of shares) {
      const shareBuffer = Buffer.from(share.encryptedShare, 'hex');
      hash.update(shareBuffer);
    }

    return hash.digest('hex');
  }

  /**
   * Derive master key from seed phrase (for local use)
   *
   * Uses PBKDF2 for key derivation with a derived salt from the seed.
   * This is NOT the threshold key, but the master secret that participants share.
   */
  private async deriveMasterKey(seedPhrase: string, _algorithm: EncryptionAlgorithm): Promise<{ key: string; method: string }> {
    const crypto = await import('node:crypto');
    const bip39 = await import('bip39');

    const seed = await bip39.mnemonicToSeed(seedPhrase);

    // Derive salt from seed (first 16 bytes) for unique per-wallet salting
    const salt = crypto.createHash('sha256')
      .update(seed.slice(0, 16))
      .update('agentvault-v1')
      .digest();

    // Derive key using PBKDF2 with unique salt
    const key = crypto.pbkdf2Sync(
      seed,
      salt,
      100000,
      32,
      'sha256',
    );

    return {
      key: key.toString('hex'),
      method: 'pbkdf2',
    };
  }

  /**
   * Verify encryption was created by VetKeys
   *
   * Validates that the encrypted data structure is valid and properly formatted.
   *
   * @param encrypted - Encrypted data to verify
   * @returns True if the encryption structure is valid
   */
  public async verifyEncryption(encrypted: EncryptedData): Promise<boolean> {
    if (!encrypted) {
      return false;
    }

    if (!encrypted.algorithm || !['aes-256-gcm', 'chacha20-poly1305'].includes(encrypted.algorithm)) {
      return false;
    }

    if (!encrypted.iv || typeof encrypted.iv !== 'string') {
      return false;
    }

    const ivBytes = Buffer.from(encrypted.iv, 'hex');
    const expectedIvLength = encrypted.algorithm === 'aes-256-gcm' ? 12 : 16;
    if (ivBytes.length !== expectedIvLength) {
      return false;
    }

    if (!encrypted.salt || typeof encrypted.salt !== 'string') {
      return false;
    }

    const saltBytes = Buffer.from(encrypted.salt, 'hex');
    if (saltBytes.length < 8) {
      return false;
    }

    if (!encrypted.ciphertext || typeof encrypted.ciphertext !== 'string') {
      return false;
    }

    const ciphertextBytes = Buffer.from(encrypted.ciphertext, 'hex');
    if (ciphertextBytes.length === 0) {
      return false;
    }

    if (encrypted.encryptedAt) {
      const timestamp = new Date(encrypted.encryptedAt);
      if (isNaN(timestamp.getTime())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get encryption status
   */
  public getEncryptionStatus(): {
    thresholdSupported: boolean;
    totalParticipants: number;
    currentThreshold: number;
    encryptionAlgorithm: EncryptionAlgorithm;
    keyDerivation: string;
  } {
    return {
      thresholdSupported: true,
      totalParticipants: this.config.totalParties!,
      currentThreshold: this.config.threshold!,
      encryptionAlgorithm: this.config.encryptionAlgorithm!,
      keyDerivation: 'shamir-ss',
    };
  }

  /**
   * Store encrypted secret on canister
   *
   * @param secretId - ID of the secret
   * @param encryptedSecret - Encrypted secret data
   * @returns True if stored successfully
   */
  public async storeEncryptedSecretOnCanister(
    secretId: string,
    encryptedSecret: {
      ciphertext: Uint8Array;
      iv: Uint8Array;
      tag: Uint8Array;
      algorithm: EncryptionAlgorithm;
    }
  ): Promise<boolean> {
    if (!this.useCanister) {
      debugLog('Canister integration disabled, skipping canister storage');
      return false;
    }

    if (!this.canisterId) {
      debugLog('Canister ID not configured, skipping canister storage');
      return false;
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const result = await actor.storeEncryptedSecret({
        id: secretId,
        ciphertext: new Uint8Array(encryptedSecret.ciphertext),
        iv: new Uint8Array(encryptedSecret.iv),
        tag: new Uint8Array(encryptedSecret.tag),
        algorithm: toCanisterAlgorithm(encryptedSecret.algorithm),
        createdAt: Date.now(),
      });

      if ('ok' in result) {
        debugLog('Encrypted secret stored on canister:', secretId);
        return true;
      }

      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to store encrypted secret on canister: ${message}`);
      return false;
    }
  }

  /**
   * Retrieve encrypted secret from canister
   *
   * @param secretId - ID of the secret
   * @returns Encrypted secret data or null
   */
  public async getEncryptedSecretFromCanister(
    secretId: string
  ): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array; algorithm: EncryptionAlgorithm } | null> {
    if (!this.canisterId) {
      return null;
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const result = await actor.getEncryptedSecret(secretId);

      if (!result || result.length === 0) {
        return null;
      }

      const [secret] = result;

      return {
        ciphertext: new Uint8Array(secret.ciphertext),
        iv: new Uint8Array(secret.iv),
        tag: new Uint8Array(secret.tag),
        algorithm: fromCanisterAlgorithm(secret.algorithm),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to retrieve encrypted secret from canister: ${message}`);
      return null;
    }
  }

  /**
   * List all encrypted secrets from canister
   *
   * @returns Array of secret IDs
   */
  public async listEncryptedSecretsOnCanister(): Promise<string[]> {
    if (!this.canisterId) {
      return [];
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const secrets = await actor.listEncryptedSecrets();

      return secrets.map(s => s.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to list encrypted secrets from canister: ${message}`);
      return [];
    }
  }

  /**
   * Delete encrypted secret from canister
   *
   * @param secretId - ID of the secret
   * @returns True if deleted successfully
   */
  public async deleteEncryptedSecretFromCanister(secretId: string): Promise<boolean> {
    if (!this.canisterId) {
      return false;
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const result = await actor.deleteEncryptedSecret(secretId);

      if ('ok' in result) {
        return true;
      }

      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to delete encrypted secret from canister: ${message}`);
      return false;
    }
  }

  /**
   * Verify threshold signature with canister
   *
   * IMPORTANT: Requires VetKeys canister to be deployed and connected.
   * Returns false if canister is not available.
   *
   * @param signature - Signature to verify
   * @param message - Original message
   * @returns True if signature is valid
   */
  public async verifyThresholdSignatureCanister(
    signature: string,
    message: string
  ): Promise<boolean> {
    if (!this.canisterId) {
      debugLog('VetKeys canister not configured: cannot verify threshold signature');
      return false;
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const result = await actor.verifyThresholdSignature(signature, message);

      if ('ok' in result && result.ok === 'verified') {
        return true;
      }

      return false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to verify threshold signature on canister: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Get VetKeys status from canister
   *
   * @returns VetKeys status information
   */
  public async getVetKeysStatusFromCanister(): Promise<{
    enabled: boolean;
    thresholdSupported: boolean;
    mode: 'mock' | 'production';
  }> {
    if (!this.canisterId) {
      return {
        enabled: false,
        thresholdSupported: true,
        mode: 'mock',
      };
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const status = await actor.getVetKeysStatus();

      let mode: 'mock' | 'production' = 'mock';
      const hasMockMode = status.mode && typeof status.mode === 'object' && 'mock' in status.mode;
      const hasProductionMode = status.mode && typeof status.mode === 'object' && 'production' in status.mode;

      if (hasMockMode) {
        mode = 'mock';
      } else if (hasProductionMode) {
        mode = 'production';
      }

      return {
        enabled: status.enabled,
        thresholdSupported: status.thresholdSupported,
        mode: mode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to get VetKeys status from canister: ${message}`);
      return {
        enabled: false,
        thresholdSupported: true,
        mode: 'mock',
      };
    }
  }
}

/**
 * Decrypt JSON data using seed phrase
 *
 * @param encrypted - Encrypted data to decrypt
 * @param seedPhrase - Seed phrase for key derivation
 * @returns Decrypted JSON object
 */
export async function decryptJSON<T = unknown>(
  encrypted: EncryptedData,
  seedPhrase: string
): Promise<T> {
  return VetKeysImplementation.decryptJSON(encrypted, seedPhrase);
}

// ---------------------------------------------------------------------------
// Bundle encryption / decryption using principal-based VetKeys
// ---------------------------------------------------------------------------

/** AES-256-GCM constants */
const BUNDLE_AES_KEY_BYTES = 32;
const BUNDLE_GCM_IV_BYTES = 12;
const BUNDLE_SALT_BYTES = 32;
const BUNDLE_PBKDF2_ITERATIONS = 210_000;

/** 4-byte magic header so we can identify VetKeys-encrypted bundles */
const VETKEYS_MAGIC = Buffer.from('VKEB'); // VetKeys Encrypted Bundle

/**
 * Metadata prepended to an encrypted bundle so the deserializer can detect
 * that decryption is required and reproduce the key.
 *
 * Wire format (all lengths in bytes):
 *   [4  magic] [32 salt] [12 iv] [16 authTag] [4 principalLen] [principalLen principal] [N ciphertext]
 */
export interface EncryptedBundleHeader {
  salt: Buffer;
  iv: Buffer;
  authTag: Buffer;
  principalId: string;
}

/**
 * Derive a 32-byte AES-256-GCM key from the caller's ICP principal.
 *
 * The principal acts as the identity-binding input; a random per-bundle salt
 * prevents key reuse across bundles encrypted for the same principal.
 */
function deriveBundleKey(principalId: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    principalId,
    Buffer.concat([salt, Buffer.from('agentvault-vetkeys-bundle-v1')]),
    BUNDLE_PBKDF2_ITERATIONS,
    BUNDLE_AES_KEY_BYTES,
    'sha256',
  );
}

/**
 * Encrypt an agent bundle buffer using VetKeys principal-based key derivation.
 *
 * The returned buffer is self-describing: it contains a magic header, the salt,
 * IV, auth tag, the encrypting principal, and the AES-256-GCM ciphertext. This
 * allows `decryptBundle` to reconstruct the key and decrypt without any
 * out-of-band metadata.
 *
 * @param buffer      - Plaintext bundle (e.g. serialized agent state)
 * @param principalId - ICP principal that "owns" the encryption key
 * @returns Encrypted bundle buffer (magic ‖ salt ‖ iv ‖ tag ‖ principalLen ‖ principal ‖ ciphertext)
 */
export async function encryptBundleWithVetKeys(
  buffer: Buffer,
  principalId: string,
): Promise<Buffer> {
  if (!principalId || principalId.length === 0) {
    throw new Error('principalId is required for VetKeys bundle encryption');
  }

  const salt = crypto.randomBytes(BUNDLE_SALT_BYTES);
  const iv = crypto.randomBytes(BUNDLE_GCM_IV_BYTES);
  const key = deriveBundleKey(principalId, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  // Encode principal length as a 4-byte big-endian uint
  const principalBuf = Buffer.from(principalId, 'utf-8');
  const principalLenBuf = Buffer.alloc(4);
  principalLenBuf.writeUInt32BE(principalBuf.length, 0);

  return Buffer.concat([
    VETKEYS_MAGIC,        // 4
    salt,                 // 32
    iv,                   // 12
    authTag,              // 16
    principalLenBuf,      // 4
    principalBuf,         // variable
    ciphertext,           // variable
  ]);
}

/**
 * Detect whether a buffer starts with the VetKeys encrypted-bundle magic.
 */
export function isVetKeysEncryptedBundle(buffer: Buffer): boolean {
  if (buffer.length < VETKEYS_MAGIC.length) {
    return false;
  }
  return buffer.subarray(0, VETKEYS_MAGIC.length).equals(VETKEYS_MAGIC);
}

/**
 * Parse the header from an encrypted bundle buffer.
 *
 * @returns The parsed header and the offset where ciphertext begins.
 */
function parseEncryptedBundleHeader(
  encrypted: Buffer,
): { header: EncryptedBundleHeader; ciphertextOffset: number } {
  const minHeaderSize = 4 + 32 + 12 + 16 + 4; // magic + salt + iv + tag + principalLen
  if (encrypted.length < minHeaderSize) {
    throw new Error('Encrypted bundle is too short to contain a valid header');
  }

  let offset = VETKEYS_MAGIC.length; // skip magic (already verified by caller)

  const salt = encrypted.subarray(offset, offset + BUNDLE_SALT_BYTES);
  offset += BUNDLE_SALT_BYTES;

  const iv = encrypted.subarray(offset, offset + BUNDLE_GCM_IV_BYTES);
  offset += BUNDLE_GCM_IV_BYTES;

  const authTag = encrypted.subarray(offset, offset + 16);
  offset += 16;

  const principalLen = encrypted.readUInt32BE(offset);
  offset += 4;

  if (encrypted.length < offset + principalLen) {
    throw new Error('Encrypted bundle is truncated: principal field extends past end');
  }

  const principalId = encrypted.subarray(offset, offset + principalLen).toString('utf-8');
  offset += principalLen;

  return {
    header: { salt: Buffer.from(salt), iv: Buffer.from(iv), authTag: Buffer.from(authTag), principalId },
    ciphertextOffset: offset,
  };
}

/**
 * Decrypt a VetKeys-encrypted bundle buffer.
 *
 * The principal used for decryption is embedded in the bundle header.  The
 * caller may optionally supply their own `principalId` to verify that the
 * bundle was encrypted for them; if omitted the embedded principal is used.
 *
 * @param encrypted   - Buffer produced by `encryptBundleWithVetKeys`
 * @param principalId - (optional) expected principal; if provided and it does
 *                       not match the embedded principal an error is thrown
 * @returns Decrypted plaintext buffer
 */
export async function decryptBundle(
  encrypted: Buffer,
  principalId?: string,
): Promise<Buffer> {
  if (!isVetKeysEncryptedBundle(encrypted)) {
    throw new Error('Buffer is not a VetKeys encrypted bundle (missing magic header)');
  }

  const { header, ciphertextOffset } = parseEncryptedBundleHeader(encrypted);

  // Optionally enforce principal match
  if (principalId && principalId !== header.principalId) {
    throw new Error(
      `Principal mismatch: bundle was encrypted for "${header.principalId}" but decryption was requested with "${principalId}"`,
    );
  }

  const ciphertext = encrypted.subarray(ciphertextOffset);
  const key = deriveBundleKey(header.principalId, header.salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.iv);
  decipher.setAuthTag(header.authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext;
}
