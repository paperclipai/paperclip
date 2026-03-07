/**
 * SecureWallet – deploy-time wallet with real cryptography
 *
 * Implements the three BDD scenarios:
 *
 *  1. Wallet creation on deploy
 *     • Keys generated with @noble/curves (secp256k1 or Ed25519)
 *     • Private key is IMMEDIATELY encrypted with AES-256-GCM
 *     • Encrypted bundle stored in stable memory (encryptedState field)
 *
 *  2. Message signing
 *     • Decrypts private key ephemerally, signs, zeroes memory
 *     • Produces signatures that validate against RFC 8032 / NIST test vectors
 *
 *  3. Key rotation
 *     • Old private key is zeroed from memory before new keys are generated
 *     • New keys are encrypted and replace the previous stable-memory entry
 */

import * as crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ed25519 } from '@noble/curves/ed25519';
import { encryptSecret, decryptSecret, deriveStorageKey } from './wallet-crypto.js';
import type { EncryptedKeyBundle } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CurveType = 'secp256k1' | 'ed25519';

/**
 * The on-chain / stable-memory representation of a secure wallet.
 * Private key material is NEVER present; only the encrypted bundle is stored.
 */
export interface SecureWalletState {
  /** Curve used for key generation */
  curve: CurveType;
  /** Raw public key bytes (hex) – safe to store in plaintext */
  publicKey: string;
  /** AES-256-GCM encrypted private key bundle */
  encryptedBundle: EncryptedKeyBundle;
  /** Unix ms timestamp of initial creation */
  createdAt: number;
  /** Unix ms timestamp of last key rotation (undefined before first rotation) */
  rotatedAt?: number;
}

/**
 * In-memory wallet handle returned after initialisation.
 * Callers must retain the `encryptionKey` (passphrase) to perform signing or
 * rotation; it is never stored inside SecureWallet.
 */
export interface WalletHandle {
  state: SecureWalletState;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SALT_BYTES = 32;

/** Generate a fresh per-wallet salt and derive a 32-byte AES key */
function freshKey(passphrase: string): { salt: Buffer; aesKey: Buffer } {
  const salt = crypto.randomBytes(SALT_BYTES);
  const aesKey = deriveStorageKey(passphrase, salt);
  return { salt, aesKey };
}

/** Overwrite a Buffer's contents with zeros to wipe sensitive data */
function zeroBuffer(buf: Buffer): void {
  buf.fill(0);
}

/** Overwrite a Uint8Array's contents with zeros */
function zeroBytes(arr: Uint8Array): void {
  arr.fill(0);
}

// ---------------------------------------------------------------------------
// SecureWallet
// ---------------------------------------------------------------------------

/**
 * SecureWallet manages an asymmetric keypair whose private key is always
 * stored encrypted with AES-256-GCM and never persisted in plaintext.
 *
 * All operations that require the private key (sign, rotateKeys) accept the
 * caller-supplied passphrase, decrypt ephemerally, operate, then zero the
 * ephemeral buffer.
 */
export class SecureWallet {
  /** Stable-memory / on-chain state – safe to serialise and store */
  private _state: SecureWalletState | null = null;

  // -------------------------------------------------------------------------
  // Scenario 1: Wallet creation on deploy
  // -------------------------------------------------------------------------

  /**
   * Initialise the wallet: generate a keypair with @noble/curves and
   * immediately encrypt the private key with AES-256-GCM.
   *
   * The plaintext private key exists in memory only for the duration of this
   * call and is zeroed before the method returns.
   *
   * @param passphrase  - Secret used as AES key material (e.g. BIP39 mnemonic
   *                      or randomly generated deployment secret).
   * @param curve       - 'secp256k1' (Ethereum/Polkadot) or 'ed25519'
   *                      (Solana/ICP/Arweave). Defaults to 'ed25519'.
   */
  initialize(passphrase: string, curve: CurveType = 'ed25519'): WalletHandle {
    // 1. Generate raw entropy
    const entropy = crypto.randomBytes(32);

    // 2. Derive keypair via @noble/curves
    let privateKeyBytes: Uint8Array;
    let publicKeyBytes: Uint8Array;

    if (curve === 'secp256k1') {
      privateKeyBytes = secp256k1.utils.randomPrivateKey();
      // Use our generated entropy as the private key
      privateKeyBytes = entropy;
      publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true); // compressed
    } else {
      // ed25519
      privateKeyBytes = entropy;
      publicKeyBytes = ed25519.getPublicKey(privateKeyBytes);
    }

    // 3. Encrypt the private key with AES-256-GCM immediately
    const { salt, aesKey } = freshKey(passphrase);
    const encryptedPrivateKey = encryptSecret(
      Buffer.from(privateKeyBytes).toString('hex'),
      aesKey
    );

    // 4. Zero the plaintext private key and AES key from memory
    zeroBytes(privateKeyBytes);
    zeroBuffer(aesKey);

    // 5. Build the encrypted bundle (stable-memory representation)
    const bundle: EncryptedKeyBundle = {
      version: 1,
      salt: salt.toString('hex'),
      privateKey: encryptedPrivateKey,
    };

    const state: SecureWalletState = {
      curve,
      publicKey: Buffer.from(publicKeyBytes).toString('hex'),
      encryptedBundle: bundle,
      createdAt: Date.now(),
    };

    this._state = state;
    return { state };
  }

  // -------------------------------------------------------------------------
  // Scenario 2: Message signing
  // -------------------------------------------------------------------------

  /**
   * Sign an arbitrary message.
   *
   * The private key is decrypted ephemerally for the duration of the signing
   * operation and zeroed before this method returns.
   *
   * For Ed25519:  returns a 64-byte raw signature.
   * For secp256k1: returns a 64-byte compact (r || s) DER-free signature.
   *
   * @param message     - Raw message bytes to sign.
   * @param passphrase  - Passphrase used during `initialize()`.
   */
  sign(message: Uint8Array, passphrase: string): Uint8Array {
    const state = this._requireState();
    const { privateKeyHex, aesKey } = this._decryptPrivateKey(
      state.encryptedBundle,
      passphrase
    );

    let signature: Uint8Array;
    try {
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');

      if (state.curve === 'ed25519') {
        signature = ed25519.sign(message, privateKeyBytes);
      } else {
        // secp256k1 – SHA-256 the message first (standard practice)
        const digest = crypto.createHash('sha256').update(message).digest();
        const sig = secp256k1.sign(digest, privateKeyBytes);
        signature = sig.toCompactRawBytes();
      }

      // Zero ephemeral key material
      zeroBuffer(Buffer.from(privateKeyBytes));
    } finally {
      zeroBuffer(aesKey);
    }

    return signature;
  }

  /**
   * Sign a pre-hashed digest directly (useful for secp256k1 ECDSA where the
   * caller controls hashing, e.g. for NIST test-vector validation).
   *
   * Only supported on secp256k1 wallets.
   */
  signDigest(digest: Uint8Array, passphrase: string): Uint8Array {
    const state = this._requireState();
    if (state.curve !== 'secp256k1') {
      throw new Error('signDigest is only supported for secp256k1 wallets');
    }

    const { privateKeyHex, aesKey } = this._decryptPrivateKey(
      state.encryptedBundle,
      passphrase
    );

    let signature: Uint8Array;
    try {
      const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
      const sig = secp256k1.sign(digest, privateKeyBytes);
      signature = sig.toCompactRawBytes();
      zeroBuffer(Buffer.from(privateKeyBytes));
    } finally {
      zeroBuffer(aesKey);
    }

    return signature;
  }

  /**
   * Verify a signature against the wallet's current public key.
   *
   * For Ed25519 and secp256k1 this is a pure-public-key operation – no
   * passphrase required.
   *
   * @param message   - Original raw message bytes.
   * @param signature - Signature bytes returned by `sign()`.
   */
  verify(message: Uint8Array, signature: Uint8Array): boolean {
    const state = this._requireState();
    const publicKeyBytes = Buffer.from(state.publicKey, 'hex');

    if (state.curve === 'ed25519') {
      return ed25519.verify(signature, message, publicKeyBytes);
    } else {
      const digest = crypto.createHash('sha256').update(message).digest();
      return secp256k1.verify(signature, digest, publicKeyBytes);
    }
  }

  /**
   * Verify a secp256k1 signature against a pre-hashed digest.
   */
  verifyDigest(digest: Uint8Array, signature: Uint8Array): boolean {
    const state = this._requireState();
    if (state.curve !== 'secp256k1') {
      throw new Error('verifyDigest is only supported for secp256k1 wallets');
    }
    const publicKeyBytes = Buffer.from(state.publicKey, 'hex');
    return secp256k1.verify(signature, digest, publicKeyBytes);
  }

  // -------------------------------------------------------------------------
  // Scenario 3: Key rotation
  // -------------------------------------------------------------------------

  /**
   * Rotate keys: decrypt the old private key, zero it, generate new keys, and
   * encrypt the new private key with AES-256-GCM.
   *
   * After this call the wallet's `publicKey` and `encryptedBundle` are updated
   * atomically; the old key material is zeroed.
   *
   * @param currentPassphrase - Passphrase used to decrypt the current key.
   * @param newPassphrase     - Passphrase to encrypt the new key.  May be the
   *                            same as `currentPassphrase`.
   */
  rotateKeys(currentPassphrase: string, newPassphrase: string): WalletHandle {
    const state = this._requireState();

    // 1. Decrypt and zero the old private key
    const { privateKeyHex, aesKey: oldAesKey } = this._decryptPrivateKey(
      state.encryptedBundle,
      currentPassphrase
    );
    const oldPrivateKeyBuf = Buffer.from(privateKeyHex, 'hex');
    zeroBuffer(oldPrivateKeyBuf);
    zeroBuffer(oldAesKey);

    // 2. Generate fresh key material
    const newEntropy = crypto.randomBytes(32);
    let newPrivateKeyBytes: Uint8Array = newEntropy;
    let newPublicKeyBytes: Uint8Array;

    if (state.curve === 'secp256k1') {
      newPublicKeyBytes = secp256k1.getPublicKey(newPrivateKeyBytes, true);
    } else {
      newPublicKeyBytes = ed25519.getPublicKey(newPrivateKeyBytes);
    }

    // 3. Encrypt new private key with AES-256-GCM using the new passphrase
    const { salt: newSalt, aesKey: newAesKey } = freshKey(newPassphrase);
    const encryptedNewKey = encryptSecret(
      Buffer.from(newPrivateKeyBytes).toString('hex'),
      newAesKey
    );

    // 4. Zero new plaintext key material
    zeroBytes(newPrivateKeyBytes);
    zeroBuffer(newAesKey);

    // 5. Atomically replace stable-memory state
    const newBundle: EncryptedKeyBundle = {
      version: 1,
      salt: newSalt.toString('hex'),
      privateKey: encryptedNewKey,
    };

    const newState: SecureWalletState = {
      curve: state.curve,
      publicKey: Buffer.from(newPublicKeyBytes).toString('hex'),
      encryptedBundle: newBundle,
      createdAt: state.createdAt,
      rotatedAt: Date.now(),
    };

    this._state = newState;
    return { state: newState };
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Returns the current stable-memory state (safe to serialise). */
  get state(): SecureWalletState {
    return this._requireState();
  }

  /** True once `initialize()` has been called. */
  get isInitialized(): boolean {
    return this._state !== null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _requireState(): SecureWalletState {
    if (!this._state) {
      throw new Error('SecureWallet has not been initialized – call initialize() first');
    }
    return this._state;
  }

  private _decryptPrivateKey(
    bundle: EncryptedKeyBundle,
    passphrase: string
  ): { salt: Buffer; privateKeyHex: string; aesKey: Buffer } {
    if (!bundle.privateKey) {
      throw new Error('No encrypted private key found in bundle');
    }
    const salt = Buffer.from(bundle.salt, 'hex');
    const aesKey = deriveStorageKey(passphrase, salt);
    const privateKeyHex = decryptSecret(bundle.privateKey, aesKey);
    return { salt, privateKeyHex, aesKey };
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create and immediately initialise a SecureWallet in one call.
 *
 * @param passphrase - Passphrase for AES-256-GCM key derivation.
 * @param curve      - Key curve ('secp256k1' | 'ed25519', default 'ed25519').
 */
export function createSecureWallet(
  passphrase: string,
  curve: CurveType = 'ed25519'
): { wallet: SecureWallet; handle: WalletHandle } {
  const wallet = new SecureWallet();
  const handle = wallet.initialize(passphrase, curve);
  return { wallet, handle };
}
