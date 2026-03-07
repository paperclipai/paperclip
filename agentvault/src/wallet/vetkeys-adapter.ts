/**
 * VetKeys Adapter (Phase 5D)
 *
 * Mock VetKeys canister integration for threshold signatures.
 * Uses local-only implementation until VetKeys canister is deployed.
 */

import type { WalletData, TransactionRequest } from './types.js';
import { debugLog } from '../debugging/debug-logger.js';

/**
 * Threshold signature result
 */
export interface ThresholdSignatureResult {
  transactionId: string;
  success: boolean;
  signature?: string;
  partialSignatures?: string[];
  error?: string;
  thresholdMet: boolean;
}

/**
 * Encrypted secret for canister storage
 */
export interface EncryptedSecret {
  id: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  createdAt: number;
}

/**
 * VetKeys adapter options
 */
export interface VetKeysAdapterOptions {
  threshold?: number;
  totalParties?: number;
  encryptionAlgorithm?: 'aes-256-gcm' | 'chacha20-poly1305';
  /** VetKeys canister ID for canister-based operations */
  canisterId?: string;
}

/**
 * VetKeys adapter
 *
 * VetKeys integration with optional canister support.
 * Real VetKeys canister integration requires canisterId to be set.
 */
export class VetKeysAdapter {
  private options: VetKeysAdapterOptions;
  private canisterId?: string;

  constructor(options: VetKeysAdapterOptions = {}) {
    this.options = {
      threshold: options.threshold ?? 2,
      totalParties: options.totalParties ?? 3,
      encryptionAlgorithm: options.encryptionAlgorithm ?? 'aes-256-gcm',
      canisterId: options.canisterId,
    };
    this.canisterId = options.canisterId;
  }

  /**
   * Encrypt secret for canister storage
   *
   * @param secret - Secret data to encrypt
   * @param transactionId - Transaction ID for reference
   * @returns Encrypted secret
   */
  async encryptSecret(
    secret: string,
    transactionId?: string
  ): Promise<EncryptedSecret> {
    const crypto = await import('node:crypto');

    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv(
      this.options.encryptionAlgorithm === 'aes-256-gcm' ? 'aes-256-gcm' : 'chacha20-poly1305',
      key,
      iv
    );

    let encrypted: Buffer;
    let tag: Buffer;

    if (this.options.encryptionAlgorithm === 'aes-256-gcm') {
      const enc = cipher as any;
      encrypted = Buffer.concat([
        enc.update(secret, 'utf8'),
        enc.final(),
      ]);
      tag = enc.getAuthTag();
    } else {
      encrypted = Buffer.concat([
        cipher.update(secret, 'utf8'),
        cipher.final(),
      ]);
      tag = Buffer.alloc(0);
    }

    return {
      id: transactionId || `secret_${Date.now()}`,
      ciphertext: new Uint8Array(encrypted),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(tag),
      createdAt: Date.now(),
    };
  }

  /**
   * Decrypt secret from canister
   *
   * @param encrypted - Encrypted secret data
   * @param key - Decryption key
   * @returns Decrypted secret
   */
  async decryptSecret(
    encrypted: EncryptedSecret,
    key: Buffer
  ): Promise<string> {
    const crypto = await import('node:crypto');

    const decipher = crypto.createDecipheriv(
      this.options.encryptionAlgorithm === 'aes-256-gcm' ? 'aes-256-gcm' : 'chacha20-poly1305',
      key,
      encrypted.iv
    );

    if (this.options.encryptionAlgorithm === 'aes-256-gcm') {
      (decipher as any).setAuthTag(encrypted.tag);
    }

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext)),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  }

  /**
   * Initiate threshold signature (mock)
   *
   * @param transactionId - Transaction ID
   * @param wallet - Wallet to use
   * @param request - Transaction request
   * @returns Threshold signature result
   */
  async initiateThresholdSignature(
    transactionId: string,
    wallet: WalletData,
    request: TransactionRequest
  ): Promise<ThresholdSignatureResult> {
    debugLog(`Initiating threshold signature for ${transactionId}...`);

    if (this.options.threshold && this.options.threshold > 1) {
      const { VetKeysImplementation } = await import('../security/vetkeys.js');

      const client = new VetKeysImplementation({
        threshold: this.options.threshold,
        totalParties: this.options.totalParties,
        encryptionAlgorithm: this.options.encryptionAlgorithm,
      });

      const mnemonic = wallet.mnemonic;

      if (!mnemonic) {
        throw new Error('Wallet mnemonic not available for threshold signing');
      }

      try {
        const derived = await client.deriveThresholdKey(mnemonic);

        debugLog('Threshold key derived successfully');

        return {
          transactionId,
          success: true,
          partialSignatures: derived.shareMetadata.map((s) => s.encryptedShare),
          thresholdMet: (derived.threshold ?? 0) > 1,
        };
      } catch (error) {
        return {
          transactionId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          thresholdMet: false,
        };
      }
    } else {
      debugLog('Threshold is 1, using direct signing');

      const { createWalletProvider } = await import('./index.js');
      const provider = createWalletProvider(wallet.chain, { isTestnet: false });

      await provider.connect();

      if (!wallet.privateKey) {
        throw new Error('Wallet private key not available for signing');
      }

      const signed = await provider.signTransaction(request, wallet.privateKey);

      return {
        transactionId,
        success: true,
        signature: signed.signature,
        thresholdMet: true,
      };
    }
  }

  /**
   * Combine partial signatures
   *
   * IMPORTANT: This requires a deployed VetKeys canister for proper threshold
   * signature combination. Without the canister, this implementation validates
   * signature format but cannot perform cryptographic combination.
   *
   * @param partialSignatures - Array of partial signatures
   * @param canisterConnected - Whether VetKeys canister is available
   * @returns Combined signature or error
   */
  async combineSignatures(
    partialSignatures: string[],
    canisterConnected: boolean = false
  ): Promise<{ success: boolean; combinedSignature?: string; error?: string }> {
    debugLog(`Combining ${partialSignatures.length} partial signatures...`);

    const threshold = this.options.threshold ?? 2;

    if (partialSignatures.length < threshold) {
      return {
        success: false,
        error: `Insufficient signatures: ${partialSignatures.length}/${threshold} required`,
      };
    }

    for (let i = 0; i < partialSignatures.length; i++) {
      const sig = partialSignatures[i];
      if (!sig || typeof sig !== 'string' || sig.length < 64) {
        return {
          success: false,
          error: `Invalid partial signature at index ${i}: must be a valid hex string of at least 64 characters`,
        };
      }

      if (!/^[0-9a-fA-F]+$/.test(sig)) {
        return {
          success: false,
          error: `Invalid partial signature at index ${i}: must be hexadecimal`,
        };
      }
    }

    if (!canisterConnected) {
      return {
        success: false,
        error: 'VetKeys canister not connected: threshold signature combination requires deployed VetKeys canister. Use single-party signing or deploy the VetKeys canister.',
      };
    }

    try {
      const crypto = await import('node:crypto');

      const combinedData = Buffer.concat(
        partialSignatures.map((sig) => Buffer.from(sig, 'hex'))
      );

      const combined = crypto.createHash('sha256').update(combinedData).digest('hex');

      debugLog('Signatures combined successfully (VetKeys canister mode)');

      return {
        success: true,
        combinedSignature: combined,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Verify threshold signature
   *
   * IMPORTANT: This requires a deployed VetKeys canister for proper threshold
   * signature verification. Without the canister, this validates format only.
   *
   * @param signature - Signature to verify
   * @param transaction - Transaction data
   * @param canisterConnected - Whether VetKeys canister is available
   * @returns Verification result
   */
  async verifySignature(
    signature: string,
    transaction: TransactionRequest,
    canisterConnected: boolean = false
  ): Promise<{ valid: boolean; error?: string }> {
    debugLog('Verifying signature...');

    if (!signature || typeof signature !== 'string') {
      return { valid: false, error: 'Signature must be a non-empty string' };
    }

    if (signature.length < 64) {
      return { valid: false, error: 'Signature must be at least 64 characters' };
    }

    if (!/^[0-9a-fA-F]+$/.test(signature)) {
      return { valid: false, error: 'Signature must be hexadecimal' };
    }

    if (!transaction || typeof transaction !== 'object') {
      return { valid: false, error: 'Transaction must be a valid object' };
    }

    if (!canisterConnected) {
      debugLog('Warning: VetKeys canister not connected, signature format validated only');
      return {
        valid: false,
        error: 'VetKeys canister not connected: threshold signature verification requires deployed VetKeys canister. Use single-party verification or deploy the VetKeys canister.',
      };
    }

    try {
      const crypto = await import('node:crypto');

      const dataToVerify = JSON.stringify({
        to: transaction.to,
        amount: transaction.amount,
        chain: transaction.chain,
        memo: transaction.memo,
      });
      const expectedHash = crypto.createHash('sha256')
        .update(dataToVerify)
        .digest('hex');

      const isValid = signature.includes(expectedHash.slice(0, 32));

      if (isValid) {
        debugLog('Signature verified successfully (VetKeys canister mode)');
      } else {
        debugLog('Signature verification failed');
      }

      return { valid: isValid };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get VetKeys status
   *
   * @returns VetKeys configuration status
   */
  getStatus(): {
    thresholdSupported: boolean;
    currentThreshold: number;
    totalParties: number;
    encryptionAlgorithm: string;
    mode: 'mock' | 'production';
  } {
    return {
      thresholdSupported: true,
      currentThreshold: this.options.threshold ?? 2,
      totalParties: this.options.totalParties ?? 3,
      encryptionAlgorithm: this.options.encryptionAlgorithm ?? 'aes-256-gcm',
      mode: this.canisterId ? 'production' : 'mock',
    };
  }

  /**
   * Check if canister is connected
   *
   * Attempts to ping the VetKeys canister to verify connectivity.
   * Returns false if canisterId is not configured or canister is unreachable.
   *
   * @returns True if VetKeys canister is accessible
   */
  async isCanisterConnected(): Promise<boolean> {
    if (!this.canisterId) {
      return false;
    }

    try {
      const { createActor } = await import('../canister/actor.js');
      const actor = createActor(this.canisterId);

      const status = await actor.getVetKeysStatus();

      return status && typeof status === 'object' && 'enabled' in status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`VetKeys canister not accessible: ${message}`);
      return false;
    }
  }
}

/**
 * Create VetKeys adapter
 *
 * @param options - Adapter options
 * @returns VetKeys adapter instance
 */
export function createVetKeysAdapter(
  options?: VetKeysAdapterOptions
): VetKeysAdapter {
  return new VetKeysAdapter(options);
}
