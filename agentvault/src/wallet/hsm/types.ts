/**
 * HSM / TEE Keygen Types
 *
 * Defines the common interface for hardware-backed key generation providers:
 *   - Ledger hardware wallets (secp256k1 / Ed25519 via APDU over USB HID)
 *   - Intel SGX Trusted Execution Environments (sealed enclave key storage)
 *
 * The central contract is that a private key NEVER leaves the secure boundary.
 * The host process only ever receives public keys and signatures.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Identifies the underlying secure element / TEE backend. */
export type HsmBackend = 'ledger' | 'sgx';

/** Curve used for the derived key-pair. */
export type HsmCurve = 'secp256k1' | 'ed25519';

// ---------------------------------------------------------------------------
// Public key result returned from device
// ---------------------------------------------------------------------------

/**
 * Result of a public-key derivation performed entirely inside the secure
 * boundary.  No private key material is included.
 */
export interface HsmPublicKeyResult {
  /** Hex-encoded compressed public key (secp256k1: 33 bytes, ed25519: 32 bytes). */
  publicKeyHex: string;
  /** Chain-native address derived from the public key on the device. */
  address: string;
  /** BIP32 / SLIP10 derivation path used. */
  derivationPath: string;
  /** Curve the key uses. */
  curve: HsmCurve;
}

// ---------------------------------------------------------------------------
// Signing result returned from device
// ---------------------------------------------------------------------------

/**
 * Result of an in-device signing operation.
 * Only the signature is returned to the host – the private key stays sealed.
 */
export interface HsmSignatureResult {
  /** DER-encoded or raw signature, hex-encoded. */
  signatureHex: string;
  /** Recovery byte (secp256k1 only; undefined for Ed25519). */
  recovery?: number;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * Minimum interface that every HSM / TEE backend must implement.
 *
 * Implementations may support only a subset of curves; callers should check
 * `supportedCurves` before invoking curve-specific methods.
 */
export interface HsmProvider {
  /** Human-readable name, e.g. "Ledger Nano X", "Intel SGX enclave v2". */
  readonly name: string;
  /** Backend type tag for serialization / display. */
  readonly backend: HsmBackend;
  /** Which curves are supported by this backend. */
  readonly supportedCurves: ReadonlyArray<HsmCurve>;

  /**
   * Open a channel to the secure element / TEE.
   * Must be called before any other method.
   *
   * @throws {HsmNotAvailableError} when device / daemon is unreachable.
   */
  open(): Promise<void>;

  /**
   * Close the channel gracefully.
   * Safe to call even if open() was never called (no-op).
   */
  close(): Promise<void>;

  /**
   * Derive a key-pair inside the device and return ONLY the public key.
   * The private key is generated and stored entirely within the secure boundary.
   *
   * @param derivationPath - BIP32 (m/purpose'/coin'/acc'/change/index) or
   *                         SLIP10 path for Ed25519 chains.
   * @param curve          - Which curve to use.
   * @returns Public key + address.  Private key is NEVER included.
   *
   * @throws {HsmCurveUnsupportedError} when `curve` is not in supportedCurves.
   * @throws {HsmOperationError} on device / enclave errors.
   */
  getPublicKey(derivationPath: string, curve: HsmCurve): Promise<HsmPublicKeyResult>;

  /**
   * Sign a 32-byte digest inside the device.
   * The host provides only the digest; the private key never crosses the boundary.
   *
   * @param derivationPath - Same path used when generating the key.
   * @param digestHex      - 32-byte Keccak / SHA-256 / Blake2 digest, hex-encoded.
   * @param curve          - Curve the key was generated on.
   * @returns Signature bytes.  Private key is NEVER included.
   */
  signDigest(
    derivationPath: string,
    digestHex: string,
    curve: HsmCurve,
  ): Promise<HsmSignatureResult>;

  /**
   * Returns a stable identifier for this specific device / enclave instance.
   * Used to record which hardware produced a given wallet.
   */
  deviceId(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/** Base class for all HSM-related errors. */
export class HsmError extends Error {
  constructor(message: string, public readonly backend: HsmBackend) {
    super(message);
    this.name = 'HsmError';
  }
}

/** Thrown when the hardware / daemon is not found or cannot be opened. */
export class HsmNotAvailableError extends HsmError {
  constructor(backend: HsmBackend, detail?: string) {
    super(
      `HSM backend "${backend}" is not available${detail ? ': ' + detail : ''}.` +
        ' Is the device connected / daemon running?',
      backend,
    );
    this.name = 'HsmNotAvailableError';
  }
}

/** Thrown when the requested curve is not supported by the backend. */
export class HsmCurveUnsupportedError extends HsmError {
  constructor(backend: HsmBackend, curve: HsmCurve) {
    super(`Backend "${backend}" does not support curve "${curve}".`, backend);
    this.name = 'HsmCurveUnsupportedError';
  }
}

/** Thrown on device / enclave operation failures. */
export class HsmOperationError extends HsmError {
  constructor(backend: HsmBackend, operation: string, cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause ?? 'unknown');
    super(`HSM operation "${operation}" failed on "${backend}": ${detail}`, backend);
    this.name = 'HsmOperationError';
  }
}

// ---------------------------------------------------------------------------
// Wallet metadata persisted alongside the WalletData
// ---------------------------------------------------------------------------

/**
 * Serialisable metadata stored in `WalletData.chainMetadata.hsm` for wallets
 * whose keys were generated by an HSM / TEE.
 *
 * This is the only artefact of the keygen that is saved locally.
 * No private key or seed phrase is ever present.
 */
export interface HsmWalletMetadata {
  /** Which backend generated this key. */
  backend: HsmBackend;
  /** Stable device identifier captured at creation time. */
  deviceId: string;
  /** BIP32 / SLIP10 derivation path used inside the device. */
  derivationPath: string;
  /** Curve the key was generated on. */
  curve: HsmCurve;
  /** ISO-8601 timestamp of key creation. */
  createdAt: string;
  /**
   * Compressed public key, hex-encoded.
   * Stored so callers can re-derive the address without querying the device.
   */
  publicKeyHex: string;
}
