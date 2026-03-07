/**
 * Canister Encryption Utilities (Phase 5D)
 *
 * Encryption utilities for secure canister communication.
 * Uses AES-256-GCM for encrypting secrets and parameters.
 */

/**
 * Encryption algorithm
 */
export type EncryptionAlgorithm = 'aes-256-gcm' | 'chacha20-poly1305';

/**
 * Encrypted data for canister storage
 */
export interface CanisterEncryptedData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  algorithm: EncryptionAlgorithm;
  timestamp: number;
}

/**
 * Encryption options
 */
export interface EncryptionOptions {
  algorithm?: EncryptionAlgorithm;
  keyLength?: number;
}

/**
 * Encryption result
 */
export interface EncryptionResult {
  success: boolean;
  encrypted?: CanisterEncryptedData;
  error?: string;
}

/**
 * Decryption result
 */
export interface DecryptionResult {
  success: boolean;
  decrypted?: string;
  error?: string;
}

/**
 * Canister encryption utilities
 */
export class CanisterEncryption {
  private defaultAlgorithm: EncryptionAlgorithm;
  private defaultKeyLength: number;

  constructor(options?: EncryptionOptions) {
    this.defaultAlgorithm = options?.algorithm ?? 'aes-256-gcm';
    this.defaultKeyLength = options?.keyLength ?? 32;
  }

  /**
   * Encrypt data for canister storage
   *
   * @param data - Data to encrypt
   * @param key - Encryption key
   * @returns Encrypted data
   */
  async encrypt(
    data: string,
    key: Buffer
  ): Promise<EncryptionResult> {
    try {
      const crypto = await import('node:crypto');

      const iv = crypto.randomBytes(12);
      const algorithm = this.defaultAlgorithm;

      let cipher: any;
      let encrypted: Buffer;
      let tag: Buffer;

      if (algorithm === 'aes-256-gcm') {
        cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        encrypted = Buffer.concat([
          cipher.update(data, 'utf8'),
          cipher.final(),
        ]);
        tag = cipher.getAuthTag();
      } else if (algorithm === 'chacha20-poly1305') {
        cipher = crypto.createCipheriv('chacha20-poly1305', key, iv);
        encrypted = Buffer.concat([
          cipher.update(data, 'utf8'),
          cipher.final(),
        ]);
        tag = cipher.getAuthTag();
      } else {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
      }

      return {
        success: true,
        encrypted: {
          ciphertext: new Uint8Array(encrypted),
          iv: new Uint8Array(iv),
          tag: new Uint8Array(tag),
          algorithm,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Decrypt data from canister
   *
   * @param encrypted - Encrypted data
   * @param key - Decryption key
   * @returns Decrypted data
   */
  async decrypt(
    encrypted: CanisterEncryptedData,
    key: Buffer
  ): Promise<DecryptionResult> {
    try {
      const crypto = await import('node:crypto');

      let decipher: any;
      const algorithm = encrypted.algorithm;

      if (algorithm === 'aes-256-gcm') {
        decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.iv);
        decipher.setAuthTag(encrypted.tag);
      } else if (algorithm === 'chacha20-poly1305') {
        decipher = crypto.createDecipheriv('chacha20-poly1305', key, encrypted.iv);
        decipher.setAuthTag(encrypted.tag);
      } else {
        throw new Error(`Unsupported algorithm: ${algorithm}`);
      }

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext)),
        decipher.final(),
      ]);

      return {
        success: true,
        decrypted: decrypted.toString('utf8'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate encryption key
   *
   * @param seed - Seed phrase or random seed
   * @returns Encryption key
   */
  async generateKey(seed?: string): Promise<Buffer> {
    const crypto = await import('node:crypto');

    if (seed) {
      const bip39 = await import('bip39');
      const bip39Seed = await bip39.mnemonicToSeed(seed);

      const key = crypto.pbkdf2Sync(
        bip39Seed,
        'agentvault-canister-encryption',
        100000,
        32,
        'sha256'
      );

      return key;
    } else {
      return crypto.randomBytes(this.defaultKeyLength);
    }
  }

  /**
   * Generate HMAC for integrity verification
   *
   * @param data - Data to authenticate
   * @param key - HMAC key
   * @returns HMAC digest
   */
  async generateHMAC(data: string, key: Buffer): Promise<string> {
    const crypto = await import('node:crypto');

    const hmac = crypto.createHmac('sha256', key);
    hmac.update(data);

    return hmac.digest('hex');
  }

  /**
   * Verify HMAC
   *
   * @param data - Data to verify
   * @param key - HMAC key
   * @param expectedHMAC - Expected HMAC value
   * @returns True if HMAC matches
   */
  async verifyHMAC(
    data: string,
    key: Buffer,
    expectedHMAC: string
  ): Promise<boolean> {
    const actualHMAC = await this.generateHMAC(data, key);

    // Use timing-safe comparison to prevent timing attacks
    const actualBuffer = Buffer.from(actualHMAC, 'utf8');
    const expectedBuffer = Buffer.from(expectedHMAC, 'utf8');

    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < actualBuffer.length; i++) {
      result |= actualBuffer[i]! ^ expectedBuffer[i]!;
    }

    return result === 0;
  }

  /**
   * Encrypt with HMAC (data + integrity check)
   *
   * @param data - Data to encrypt
   * @param key - Encryption key
   * @returns Encrypted data with HMAC
   */
  async encryptWithHMAC(
    data: string,
    key: Buffer
  ): Promise<{
    success: boolean;
    encrypted?: CanisterEncryptedData;
    hmac?: string;
    error?: string;
  }> {
    const encryptionResult = await this.encrypt(data, key);

    if (!encryptionResult.success || !encryptionResult.encrypted) {
      return {
        success: false,
        error: encryptionResult.error,
      };
    }

    const hmac = await this.generateHMAC(data, key);

    return {
      success: true,
      encrypted: encryptionResult.encrypted,
      hmac,
    };
  }

  /**
   * Decrypt and verify HMAC
   *
   * @param encrypted - Encrypted data
   * @param key - Decryption key
   * @param expectedHMAC - Expected HMAC value
   * @returns Decrypted data with verification status
   */
  async decryptAndVerifyHMAC(
    encrypted: CanisterEncryptedData,
    key: Buffer,
    expectedHMAC: string
  ): Promise<{
    success: boolean;
    decrypted?: string;
    hmacValid?: boolean;
    error?: string;
  }> {
    const decryptionResult = await this.decrypt(encrypted, key);

    if (!decryptionResult.success || !decryptionResult.decrypted) {
      return {
        success: false,
        error: decryptionResult.error,
      };
    }

    const hmacValid = await this.verifyHMAC(
      decryptionResult.decrypted,
      key,
      expectedHMAC
    );

    if (!hmacValid) {
      return {
        success: false,
        error: 'HMAC verification failed',
      };
    }

    return {
      success: true,
      decrypted: decryptionResult.decrypted,
      hmacValid: true,
    };
  }

  /**
   * Convert object to encrypted hex string
   *
   * @param obj - Object to encrypt
   * @param key - Encryption key
   * @returns Encrypted hex string
   */
  async encryptObject<T>(
    obj: T,
    key: Buffer
  ): Promise<{
    success: boolean;
    encrypted?: CanisterEncryptedData;
    error?: string;
  }> {
    try {
      const json = JSON.stringify(obj);
      const result = await this.encrypt(json, key);

      if (!result.success || !result.encrypted) {
        return {
          success: false,
          error: result.error,
        };
      }

      const hex = Buffer.from(result.encrypted.ciphertext).toString('hex');

      return {
        success: true,
        encrypted: {
          ...result.encrypted,
          ciphertext: new Uint8Array(Buffer.from(hex, 'hex')),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Decrypt object from hex string
   *
   * @param encrypted - Encrypted data
   * @param key - Decryption key
   * @returns Decrypted object
   */
  async decryptObject<T>(
    encrypted: CanisterEncryptedData,
    key: Buffer
  ): Promise<{
    success: boolean;
    decrypted?: T;
    error?: string;
  }> {
    const decryptionResult = await this.decrypt(encrypted, key);

    if (!decryptionResult.success || !decryptionResult.decrypted) {
      return {
        success: false,
        error: decryptionResult.error,
      };
    }

    try {
      const obj = JSON.parse(decryptionResult.decrypted) as T;

      return {
        success: true,
        decrypted: obj,
      };
    } catch (error) {
      return {
        success: false,
        error: `JSON parse failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get default algorithm
   */
  getAlgorithm(): EncryptionAlgorithm {
    return this.defaultAlgorithm;
  }

  /**
   * Get default key length
   */
  getKeyLength(): number {
    return this.defaultKeyLength;
  }
}

/**
 * Create canister encryption instance
 *
 * @param options - Encryption options
 * @returns Canister encryption instance
 */
export function createCanisterEncryption(
  options?: EncryptionOptions
): CanisterEncryption {
  return new CanisterEncryption(options);
}
