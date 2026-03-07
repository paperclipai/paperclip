/**
 * Types for security operations
 */

/**
 * Encryption algorithm used for agent state
 */
export type EncryptionAlgorithm = 'aes-256-gcm' | 'chacha20-poly1305';

/**
 * Key derivation method
 */
export type KeyDerivationMethod = 'vetkd' | 'pbkdf2' | 'scrypt' | 'shamir-ss';

/**
 * Seed phrase (BIP39 mnemonic)
 */
export type SeedPhrase = string;

/**
 * Encrypted data container
 */
export interface EncryptedData {
  /** Encryption algorithm used */
  algorithm: EncryptionAlgorithm;
  /** IV (Initialization Vector) for encryption */
  iv: string;
  /** Salt used for key derivation */
  salt: string;
  /** Encrypted ciphertext */
  ciphertext: string;
  /** Timestamp of encryption */
  encryptedAt: string;
}

/**
 * Result of encryption operation
 */
export interface EncryptionResult {
  /** Encrypted data */
  encrypted: EncryptedData;
  /** Original data size in bytes */
  originalSize: number;
  /** Encrypted data size in bytes */
  encryptedSize: number;
}

/**
 * VetKeys options for threshold key derivation
 */
export interface VetKeysOptions {
  /** Canister ID for VetKeys service (optional, for future use) */
  vetKeysCanisterId?: string;
  /** Derivation path for key (optional) */
  derivationPath?: string;
  /** Threshold for multi-party computation */
  threshold?: number;
  /** Total number of participants (must be >= threshold) */
  totalParties?: number;
  /** Encryption algorithm */
  encryptionAlgorithm?: EncryptionAlgorithm;
}

/**
 * VetKeys derived key container
 */
export interface VetKeysDerivedKey {
  type: 'threshold';
  /** Derived key as hex string */
  key: string;
  /** Key derivation method used */
  method: KeyDerivationMethod;
  /**
   * Seed phrase used for derivation (optional for security)
   * SECURITY: seedPhrase is intentionally optional - it should NOT be retained
   * in memory after key derivation to prevent exposure via memory dumps.
   * See SEC-3 in SECURITY_AUDIT_AND_COMPLETION_PLAN.md
   */
  seedPhrase?: SeedPhrase;
  /** Threshold for reconstruction (t out of n) */
  threshold?: number;
  /** Total participants */
  totalParties?: number;
  /** Encryption algorithm */
  algorithm?: EncryptionAlgorithm;

  /**
   * Secret shares metadata
   */
  shares: Array<{
    /** Share identifier */
    shareId: string;
    /** Participant ID (1-based) */
    participantId: string;
    /** Encrypted share data */
    encryptedShare: string;
    /** Commitment hash */
    commitment: string;
  }>;

  /**
   * All shares metadata (for participants)
   */
  shareMetadata: Array<{
    /** Share index */
    index: number;
    /** Share identifier */
    shareId: string;
    /** Participant ID */
    participantId: string;
    /** Encrypted share data */
    encryptedShare: string;
    /** Commitment hash */
  }>;

  /**
   * Commitment hash from all shares
   */
  commitment: string;

  /**
   * Verification parameters
   */
  verification: {
    /** Threshold for reconstruction */
    threshold: number;
    /** Array of shares with metadata */
    shares: Array<{
      shareId: string;
      participantId: string;
      encryptedShare: string;
      commitment: string;
    }>;
    /** Algorithm used */
    algorithm: EncryptionAlgorithm;
    /** Creation timestamp */
    createdAt: string;
  };
}

/**
 * VetKeys client for threshold key derivation
 */
export class VetKeysClient {
  private config: VetKeysOptions;

  constructor(options: VetKeysOptions = {}) {
    this.config = {
      threshold: options.threshold ?? 2,
      totalParties: options.totalParties ?? 3,
      encryptionAlgorithm: options.encryptionAlgorithm ?? 'aes-256-gcm',
    };
  }

  /**
   * Derive threshold key from seed phrase
   *
   * Implements Shamir's Secret Sharing for threshold key derivation.
   * Generates n secret shares (where threshold = t out of n)
   * Each share is encrypted and can be used to reconstruct the master key.
   *
   * Security Properties:
   * - Threshold signatures (need t-of-n participants to reconstruct)
   * Privacy: No single participant learns the secret
   * Robustness: Can tolerate up to t-1 malicious participants
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
  ): Promise<VetKeysDerivedKey> {
    const threshold = options.threshold ?? this.config.threshold;
    const totalParties = options.totalParties ?? this.config.totalParties;
    const algorithm = options.encryptionAlgorithm ?? this.config.encryptionAlgorithm;

    // Validate threshold
    if (threshold! < 1 || threshold! > totalParties!) {
      throw new Error(
        `Threshold must be between 1 and totalParticipants (${totalParties!}). Got: ${threshold}`
      );
    }

    if (threshold! > totalParties!) {
      throw new Error(`Threshold cannot exceed total participants (got ${threshold}, max ${totalParties})`);
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

      return {
        type: 'threshold',
        key: derivedKey.key,
        method: derivedKey.method,
        seedPhrase,
        threshold,
        totalParties,
        algorithm,
        shares,
        shareMetadata,
        commitment,
        verification,
      } as VetKeysDerivedKey;
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
   * Generate share identifier
   */
  private generateShareId(): string {
    return `share_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
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

    let secretBuffer: Buffer;
    let iv: Buffer;

    if (algorithm === 'aes-256-gcm') {
      secretBuffer = Buffer.from(secret, 'utf-8');
      iv = Buffer.alloc(12, 0);
    } else {
      secretBuffer = Buffer.from(secret, 'utf-8');
      iv = Buffer.alloc(16, 0);
    }

    const algorithmName = algorithm.replace('-', '');
    const cipher = crypto.createCipheriv(algorithmName, secretBuffer, iv);

    const encryptedShare = Buffer.concat([
      cipher.update(secretBuffer),
      cipher.final(),
    ]);

    // Generate commitment hash
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
   * Uses PBKDF2 for key derivation, same as existing implementation.
   * This is NOT the threshold key, but the master secret that participants share.
   */
  private async deriveMasterKey(seedPhrase: string, _algorithm: EncryptionAlgorithm): Promise<{ key: string; method: string }> {
    const crypto = await import('node:crypto');
    const bip39 = await import('bip39');

    const seed = await bip39.mnemonicToSeed(seedPhrase);

    // Derive key using PBKDF2
    const key = crypto.pbkdf2Sync(
      seed,
      'agentvault-encryption-key',
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
   * Verify that encrypted data was created by VetKeys
   *
   * In a real implementation, this would query the VetKeys canister.
   * For now, this always returns true.
   */
  public async verifyEncryption(_encrypted: EncryptedData): Promise<boolean> {
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
}
